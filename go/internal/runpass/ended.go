package runpass

import (
	"context"
	"fmt"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/ended"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mask"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipview"
)

// keepEnd runs while the exited hold's credential files still exist.
func (p Pass) keepEnd(entry reconciler.Entry, reason string) {
	if p.Paths.Home == "" {
		return
	}
	if err := p.writeEnd(entry, reason); err != nil {
		p.Log(fmt.Sprintf("%s (%s): could not keep last end: %v; restart continues", nameOf(entry), entry.ShipID, err))
	}
}

func (p Pass) writeEnd(entry reconciler.Entry, reason string) error {
	now := p.Now()
	if entry.LaunchedAt == "" {
		entry.LaunchedAt = entry.Since
	}
	end := ended.End{EndedAt: now.Format(time.RFC3339Nano), StartedAt: entry.LaunchedAt, Harness: entry.Harness, Lines: []ended.Line{}}
	// Failure to load any known secret suppresses content, including the reason.
	masker, err := mask.Load(context.Background(), p.Paths)
	if err != nil {
		end.ExitReason = "not shown: cannot load known secrets to mask the exit reason"
		end.LinesError = err.Error()
	} else {
		end.ExitReason = masker.Line(reason)
		view, err := shipview.Ship(p.Paths, entry.ShipID, now)
		if err != nil {
			return fmt.Errorf("read ship view for last end: %w", err)
		}
		end.SessionID = view.Session.SessionID
		end.Activity = view.Session.Activity
		end.Lines = view.Lines
		for _, failure := range view.Unreadable {
			if failure.Fact == "masking" || failure.Fact == "activity" {
				end.LinesError = fmt.Sprintf("%s: %s", failure.Path, failure.Error)
			}
		}
	}
	return ended.Write(p.Paths.Home, entry.ShipID, end)
}

// removeEnd belongs to the same cleanup as the ship's folder.
func (p Pass) removeEnd(shipID string) error {
	if p.Paths.Home == "" {
		return nil
	}
	return ended.Remove(p.Paths.Home, shipID)
}
