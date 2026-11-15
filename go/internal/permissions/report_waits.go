package permissions

import (
	"context"
	"errors"
	"slices"
	"sync"
)

// errAskCancelled ends an ask whose call was cancelled before its waiting report.
var errAskCancelled = errors.New("permission call cancelled")

// ReportWaits shares each ship's report among its overlapping permission asks.
// While any ask is open the report names the most recent one; when the last
// ends, the report from before the first comes back, unless a newer report
// replaced the waiting one meanwhile.
type ReportWaits struct {
	mu    sync.Mutex
	ships map[string]*shipReportWaits
}

type shipReportWaits struct {
	mu      sync.Mutex
	before  Report
	written Report
	pending bool
	open    []*Report
}

func (w *ReportWaits) of(ship string) *shipReportWaits {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ships == nil {
		w.ships = make(map[string]*shipReportWaits)
	}
	waits, ok := w.ships[ship]
	if !ok {
		waits = &shipReportWaits{}
		w.ships[ship] = waits
	}
	return waits
}

// begin writes the ask's waiting report and tracks it even if verification fails.
func (w *ReportWaits) begin(ctx context.Context, reports Reports, ship string, waiting Report) (func(context.Context) error, error) {
	waits := w.of(ship)
	waits.mu.Lock()
	defer waits.mu.Unlock()
	current, err := reports.ReadReport(ctx, ship)
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, errAskCancelled
	}
	if waits.pending && current.State == waits.written.State && current.Note == waits.written.Note {
		waits.written = current
		waits.pending = false
	}
	// The report a later ask finds is the one to restore when no ask of ours
	// wrote it: either none is open, or a newer report replaced ours.
	before := waits.before
	if len(waits.open) == 0 || current != waits.written {
		before = current
	}
	if err = reports.WriteReport(context.WithoutCancel(ctx), ship, waiting); err != nil {
		return nil, err
	}
	ask := &waiting
	waits.before = before
	waits.written = waiting
	waits.pending = true
	waits.open = append(waits.open, ask)
	end := func(ctx context.Context) error { return waits.end(ctx, reports, ship, ask) }
	written, err := reports.ReadReport(context.WithoutCancel(ctx), ship)
	if err != nil {
		return end, err
	}
	if written.State != waiting.State || written.Note != waiting.Note {
		waits.open = slices.DeleteFunc(waits.open, func(open *Report) bool { return open == ask })
		waits.pending = false
		return nil, nil
	}
	waits.written = written
	waits.pending = false
	return end, nil
}

// end closes one ask. The report moves to the most recent remaining ask, or
// back to the report from before the first, only while it is still ours.
func (s *shipReportWaits) end(ctx context.Context, reports Reports, ship string, ask *Report) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.open = slices.DeleteFunc(s.open, func(open *Report) bool { return open == ask })
	current, err := reports.ReadReport(ctx, ship)
	if err != nil {
		return err
	}
	if s.pending {
		if current.State != s.written.State || current.Note != s.written.Note {
			return nil
		}
		s.written = current
		s.pending = false
	}
	if current != s.written {
		return nil
	}
	next := s.before
	if len(s.open) > 0 {
		next = *s.open[len(s.open)-1]
		if current.State == next.State && current.Note == next.Note {
			return nil
		}
	}
	// A concurrent report between this read and the write can still be overwritten.
	if err = reports.WriteReport(ctx, ship, next); err != nil || len(s.open) == 0 {
		return err
	}
	s.written = next
	s.pending = true
	written, err := reports.ReadReport(ctx, ship)
	if err != nil {
		return err
	}
	if written.State == next.State && written.Note == next.Note {
		s.written = written
		s.pending = false
	}
	return nil
}
