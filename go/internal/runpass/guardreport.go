package runpass

import (
	"fmt"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// GuardStatuses read what the guard applies to each ship and what it refused.
type GuardStatuses interface {
	// GuardStatus is the ship's guard status; false when no rules are kept for it.
	GuardStatus(shipID string) (guard.Status, bool, error)
}

// GuardReports report each guarded session's guard to the fleet (aeolus-fleet docs/design/guard, section 4.8): its status with the
// crew status of its settings version, and each new refusal as its session's latest activity, of kind refused with the tool's name.
// Both are safe to repeat, as a report the fleet took but the trierarch did not keep is made again: a status replaces the one
// before, and a refusal's key is the same on every try, so the fleet keeps one activity for it.
type GuardReports interface {
	ReportGuard(shipID string, settingsVersion int, status guard.Status) error
	ReportRefused(shipID string, key string, at time.Time, tool string) error
}

// reportGuards reports the guard of each guarded session that started, with the settings version its rules were kept for once its
// entry is at that version: each refusal not reported yet, then its status when its version or refusal count changed. Each report
// is kept as it is made, so one that fails is logged and only it, and what follows it, is tried again on the next pass.
func (p Pass) reportGuards(state reconciler.State) reconciler.State {
	if p.GuardStatuses == nil || p.GuardReports == nil {
		return state
	}
	for _, shipID := range sortedIDs(state.Entries) {
		entry := state.Entries[shipID]
		if _, ok := guardedOf(p.Harnesses[entry.Harness]); !ok || !entry.HasStarted || entry.Folder == "" || entry.State == "releasing" {
			continue
		}
		status, ok, err := p.GuardStatuses.GuardStatus(shipID)
		if err != nil {
			p.Log(fmt.Sprintf("The guard of %s (%s) was not read: %v; the next pass tries again", nameOf(entry), shipID, err))
			continue
		}
		if !ok || status.SettingsVersion != entry.SettingsVersion {
			continue
		}
		state = p.reportGuard(state, entry, status)
	}
	return state
}

// reportGuard reports the entry's guard status, then each of its refusals not reported yet, keeping each as it is reported. A report
// that could not be kept is kept with the pass's state at its end, or made again under the same key on the next pass.
func (p Pass) reportGuard(state reconciler.State, entry reconciler.Entry, status guard.Status) reconciler.State {
	if reported := guardReportedOf(status.SettingsVersion, status.Refusals); reported != entry.GuardReported {
		if err := p.GuardReports.ReportGuard(entry.ShipID, status.SettingsVersion, status); err != nil {
			p.Log(fmt.Sprintf("The guard of %s (%s) was not reported: %v; the next pass tries again", nameOf(entry), entry.ShipID, err))
			return state
		}
		entry.GuardReported = reported
		state = p.keptReported(state, entry)
	}
	// The status holds the last refusals only: an older one not reported yet is no longer there to report.
	first := status.Refusals - len(status.Recent) + 1
	for number := max(entry.RefusalsReported+1, first); number <= status.Refusals; number++ {
		refusal := status.Recent[number-first]
		if err := p.GuardReports.ReportRefused(entry.ShipID, refusalKey(entry.ShipID, number), refusal.At, refusal.Tool); err != nil {
			p.Log(fmt.Sprintf("The refusal of %s (%s) was not reported: %v; the next pass tries again", nameOf(entry), entry.ShipID, err))
			return state
		}
		entry.RefusalsReported = number
		state = p.keptReported(state, entry)
	}
	return state
}

// keptReported keeps what the entry reported; one that could not be kept is logged.
func (p Pass) keptReported(state reconciler.State, entry reconciler.Entry) reconciler.State {
	next, err := p.put(state, entry)
	if err != nil {
		p.Log(fmt.Sprintf("The guard reported for %s (%s) was not kept: %v", nameOf(entry), entry.ShipID, err))
	}
	return next
}

// refusalKey is the key of the ship's refusal with that number in its guard folder, the same on every try.
func refusalKey(shipID string, number int) string {
	return fmt.Sprintf("trierarch:guard-refused:%s:%d", shipID, number)
}

// guardReportedOf is what an entry keeps of the guard status it reported: its settings version and refusal count.
func guardReportedOf(settingsVersion int, refusals int) string {
	return fmt.Sprintf("%d:%d", settingsVersion, refusals)
}
