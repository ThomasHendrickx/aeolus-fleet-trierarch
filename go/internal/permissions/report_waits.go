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

// begin writes the ask's waiting report. It answers no end when the report
// could not be written or was replaced at once, so nothing is restored for it.
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
	// The report a later ask finds is the one to restore when no ask of ours
	// wrote it: either none is open, or a newer report replaced ours.
	before := waits.before
	if len(waits.open) == 0 || current != waits.written {
		before = current
	}
	if err = reports.WriteReport(context.WithoutCancel(ctx), ship, waiting); err != nil {
		return nil, err
	}
	written, err := reports.ReadReport(context.WithoutCancel(ctx), ship)
	if err != nil {
		return nil, err
	}
	if written.State != waiting.State || written.Note != waiting.Note {
		return nil, nil
	}
	ask := &waiting
	waits.before = before
	waits.written = written
	waits.open = append(waits.open, ask)
	return func(ctx context.Context) error { return waits.end(ctx, reports, ship, ask) }, nil
}

// end closes one ask. The report moves to the most recent remaining ask, or
// back to the report from before the first, only while it is still ours.
func (s *shipReportWaits) end(ctx context.Context, reports Reports, ship string, ask *Report) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.open = slices.DeleteFunc(s.open, func(open *Report) bool { return open == ask })
	current, err := reports.ReadReport(ctx, ship)
	if err != nil || current != s.written {
		return err
	}
	next := s.before
	if len(s.open) > 0 {
		next = *s.open[len(s.open)-1]
		if current.State == next.State && current.Note == next.Note {
			return nil
		}
	}
	if err = reports.WriteReport(ctx, ship, next); err != nil || len(s.open) == 0 {
		return err
	}
	s.written, err = reports.ReadReport(ctx, ship)
	return err
}
