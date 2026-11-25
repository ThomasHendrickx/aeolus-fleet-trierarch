package runpass

import (
	"context"
	"fmt"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// GuardStatuses read what the guard applies to each ship and what it refused.
type GuardStatuses interface {
	// GuardStatus is the ship's guard status; false when no rules are kept for it.
	GuardStatus(ctx context.Context, shipID string) (guard.Status, bool, error)
}

// GuardReports report each guarded session's guard to the fleet (aeolus-fleet docs/design/guard, section 4.8): its status with the
// crew status of its settings version, and each new refusal as its session's latest activity, of kind refused with the tool's name.
// Both are safe to repeat, as a report the fleet took but the trierarch did not keep is made again: a status replaces the one
// before, and a refusal's timestamp and tool are the same on every try, replacing the lease's latest activity.
type GuardReports interface {
	ReportGuard(shipID string, crew reconciler.Status, status guard.Status) error
	ReportRefused(shipID string, intervalSeconds int, refused activity.Activity) error
}

// guardStatusOf reads what the running session applied, ignoring rules for a different settings version
// or an empty resolution, which starts without a guard.
func (p Pass) guardStatusOf(ctx context.Context, entry reconciler.Entry) (guard.Status, bool) {
	if p.GuardStatuses == nil || p.GuardReports == nil || !entry.HasStarted || entry.State != "running" || entry.Folder == "" {
		return guard.Status{}, false
	}
	if _, ok := guardedOf(p.Harnesses[entry.Harness]); !ok {
		return guard.Status{}, false
	}
	read, cancel := context.WithTimeout(ctx, guardReadWait)
	defer cancel()
	status, ok, err := p.GuardStatuses.GuardStatus(read, entry.ShipID)
	if err != nil {
		p.Log(fmt.Sprintf("The guard of %s (%s) was not read: %v; the next pass tries again", nameOf(entry), entry.ShipID, err))
		return guard.Status{}, false
	}
	return status, ok && status.SettingsVersion == entry.SettingsVersion && len(status.Sets) > 0
}

// reportGuards reports the guards of running sessions after reconciling their settings versions. Its latest refusals
// also take part in the regular activity report, which keeps the latest event fresh while the session runs.
func (p Pass) reportGuards(ctx context.Context, state reconciler.State) map[string]activity.Activity {
	latest := map[string]activity.Activity{}
	for _, shipID := range sortedIDs(state.Entries) {
		entry := state.Entries[shipID]
		status, ok := p.guardStatusOf(ctx, entry)
		if !ok {
			continue
		}
		state = p.reportGuard(state, entry, status)
		if len(status.Recent) > 0 {
			refused := status.Recent[len(status.Recent)-1]
			started, _ := time.Parse(time.RFC3339Nano, entry.Since)
			if !refused.At.Before(started) {
				latest[shipID] = refusalActivity(refused)
			}
		}
	}
	return latest
}

func refusalActivity(refused guard.RecentRefusal) activity.Activity {
	return activity.Activity{Kind: "refused", Tool: refused.Tool, At: refused.At}
}

// writeCrewStatus includes the guard in the normal running status, since core clears the guard when omitted.
func (p Pass) writeCrewStatus(ctx context.Context, state reconciler.State, action reconciler.Action) (reconciler.State, error) {
	crew := action.Status
	crew.StartedAt = fleetTime(crew.StartedAt)
	entry := state.Entries[action.ShipID]
	if status, ok := p.guardStatusOf(ctx, entry); ok && crew.Status == "running" {
		if err := p.GuardReports.ReportGuard(entry.ShipID, crew, status); err != nil {
			return state, err
		}
		entry.GuardReported = guardReportedOf(status)
		return p.keptReported(state, entry), nil
	}
	if err := p.Fleet.WriteStatus(action.ShipID, crew.Status, crew.Attempt, crew.StartedAt); err != nil {
		return state, err
	}
	if entry.GuardReported != "" {
		entry.GuardReported = ""
		return p.keptReported(state, entry), nil
	}
	return state, nil
}

// reportGuard reports the entry's guard status, then each of its refusals not reported yet, keeping each as it is reported. A report
// that could not be kept is kept with the pass's state at its end, or made again on the next pass.
func (p Pass) reportGuard(state reconciler.State, entry reconciler.Entry, status guard.Status) reconciler.State {
	if reported := guardReportedOf(status); reported != entry.GuardReported {
		crew := reconciler.Status{Status: entry.State, Attempt: len(entry.Exits), StartedAt: fleetTime(entry.Since)}
		if err := p.GuardReports.ReportGuard(entry.ShipID, crew, status); err != nil {
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
		if err := p.GuardReports.ReportRefused(entry.ShipID, activityIntervalSeconds, refusalActivity(refusal)); err != nil {
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

// guardReportedOf is what an entry keeps of the guard status it reported.
func guardReportedOf(status guard.Status) string {
	return fmt.Sprintf("%d:%d", status.SettingsVersion, status.Refusals)
}
