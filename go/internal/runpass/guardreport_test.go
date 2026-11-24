package runpass

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
)

// someGuardStatuses are what each guarded session applied and refused, by ship.
type someGuardStatuses map[string]guard.Status

func (s someGuardStatuses) GuardStatus(shipID string) (guard.Status, bool, error) {
	status, ok := s[shipID]
	return status, ok, nil
}

// someGuardReports are the guard statuses and refused activities reported, in order.
type someGuardReports struct{ reported []string }

func (r *someGuardReports) ReportGuard(shipID string, settingsVersion int, status guard.Status) error {
	r.reported = append(r.reported, fmt.Sprintf("guard %s %d %d sets %d refusals", shipID, settingsVersion, len(status.Sets), status.Refusals))
	return nil
}

func (r *someGuardReports) ReportRefused(shipID string, at time.Time, tool string) error {
	r.reported = append(r.reported, fmt.Sprintf("refused %s %s %s", shipID, at.UTC().Format(time.RFC3339), tool))
	return nil
}

var refusedAt = time.Date(2026, 11, 4, 12, 0, 3, 0, time.UTC)

func aGuardStatus(refusals int) guard.Status {
	set, commit := "no-push", "8d41e07aa1"
	status := guard.Status{Sets: []guard.AppliedSet{{Name: "no-push", Repository: "fleet/rules", Commit: commit, Floor: true}}, Refusals: refusals, Recent: []guard.RecentRefusal{}}
	for at := range refusals {
		status.Recent = append(status.Recent, guard.RecentRefusal{At: refusedAt.Add(time.Duration(at) * time.Second), Tool: "Bash", Rule: "git.deny push", Set: &set, Commit: &commit})
	}
	return status
}

// aReportingPass is a crewed guarded pass whose scout applied and refused as its status says.
func aReportingPass(t *testing.T, status guard.Status) (*aPass, someGuardStatuses, *someGuardReports) {
	t.Helper()
	pass, _ := aGuardedPass(t, someGuardRules{scout: 1})
	statuses, reports := someGuardStatuses{scout: status}, &someGuardReports{}
	pass.pass.GuardStatuses, pass.pass.GuardReports = statuses, reports
	pass.crewed(t)
	reports.reported = nil
	return pass, statuses, reports
}

func TestAGuardedSessionsGuardIsReportedWithItsSettingsVersionOnceUntilItChanges(t *testing.T) {
	pass, _, reports := aReportingPass(t, aGuardStatus(0))

	pass.run(t)
	pass.run(t)

	if want := []string{}; !slices.Equal(reports.reported, want) {
		t.Fatalf("reported %q after it was reported while crewing, want nothing more", reports.reported)
	}
}

func TestAGuardIsReportedAsTheSessionStarts(t *testing.T) {
	pass, _ := aGuardedPass(t, someGuardRules{scout: 1})
	reports := &someGuardReports{}
	pass.pass.GuardStatuses, pass.pass.GuardReports = someGuardStatuses{scout: aGuardStatus(0)}, reports

	pass.crewed(t)

	if want := []string{"guard " + scout + " 1 1 sets 0 refusals"}; !slices.Equal(reports.reported, want) {
		t.Fatalf("reported %q, want %q", reports.reported, want)
	}
}

func TestANewRefusalIsReportedWithTheGuardAndAsTheSessionsRefusedActivity(t *testing.T) {
	pass, statuses, reports := aReportingPass(t, aGuardStatus(0))
	statuses[scout] = aGuardStatus(2)

	pass.run(t)
	pass.run(t)

	want := []string{"guard " + scout + " 1 1 sets 2 refusals", "refused " + scout + " 2026-11-04T12:00:04Z Bash"}
	if !slices.Equal(reports.reported, want) {
		t.Fatalf("reported %q, want %q", reports.reported, want)
	}
}

func TestNoGuardIsReportedForAHarnessWithoutAGuard(t *testing.T) {
	pass := aRunPass(t)
	reports := &someGuardReports{}
	pass.pass.GuardStatuses, pass.pass.GuardReports = someGuardStatuses{scout: aGuardStatus(1)}, reports

	pass.crewed(t)
	pass.run(t)

	if len(reports.reported) != 0 {
		t.Fatalf("reported %q, want nothing", reports.reported)
	}
}
