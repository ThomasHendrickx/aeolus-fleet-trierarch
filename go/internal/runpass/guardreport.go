package runpass

import (
	"fmt"
	"strconv"
	"strings"
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
type GuardReports interface {
	ReportGuard(shipID string, settingsVersion int, status guard.Status) error
	ReportRefused(shipID string, at time.Time, tool string) error
}

// reportGuards reports the guard of each guarded session that started, when its settings version or refusal count changed since it was
// last reported; a report that fails is logged and tried again on the next pass.
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
		reported := guardReportedOf(entry.SettingsVersion, status.Refusals)
		if !ok || reported == entry.GuardReported {
			continue
		}
		if err := p.GuardReports.ReportGuard(shipID, entry.SettingsVersion, status); err != nil {
			p.Log(fmt.Sprintf("The guard of %s (%s) was not reported: %v; the next pass tries again", nameOf(entry), shipID, err))
			continue
		}
		if status.Refusals > refusalsReported(entry) && len(status.Recent) > 0 {
			newest := status.Recent[len(status.Recent)-1]
			if err := p.GuardReports.ReportRefused(shipID, newest.At, newest.Tool); err != nil {
				p.Log(fmt.Sprintf("The refusal of %s (%s) was not reported: %v; the next pass tries again", nameOf(entry), shipID, err))
				continue
			}
		}
		entry.GuardReported = reported
		next, err := p.put(state, entry)
		if err != nil {
			p.Log(fmt.Sprintf("The guard reported for %s (%s) was not kept: %v", nameOf(entry), shipID, err))
			continue
		}
		state = next
	}
	return state
}

// guardReportedOf is what an entry keeps of the guard it reported: its settings version and refusal count.
func guardReportedOf(settingsVersion int, refusals int) string {
	return fmt.Sprintf("%d:%d", settingsVersion, refusals)
}

// refusalsReported is how many refusals the entry reported at its settings version, none at another.
func refusalsReported(entry reconciler.Entry) int {
	version, count, ok := strings.Cut(entry.GuardReported, ":")
	if !ok || version != strconv.Itoa(entry.SettingsVersion) {
		return 0
	}
	reported, err := strconv.Atoi(count)
	if err != nil {
		return 0
	}
	return reported
}
