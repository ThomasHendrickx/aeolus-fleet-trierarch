package runpass

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// someGuardStatuses are what each guarded session applied and refused, by ship.
type someGuardStatuses map[string]guard.Status

func (s someGuardStatuses) GuardStatus(_ context.Context, shipID string) (guard.Status, bool, error) {
	status, ok := s[shipID]
	return status, ok, nil
}

// someGuardReports are the guard statuses and refused activities reported, in order; the next calls of each kind fail as many times
// as given, the fleet having taken none of them.
type someGuardReports struct {
	reported      []string
	guardFails    int
	refusedFails  int
	refusedEvents []activity.Activity
}

func (r *someGuardReports) ReportGuard(shipID string, _ reconciler.Status, status guard.Status) error {
	if r.guardFails > 0 {
		r.guardFails--
		return errors.New("the fleet does not answer")
	}
	r.reported = append(r.reported, fmt.Sprintf("guard %s %d %d sets %d refusals", shipID, status.SettingsVersion, len(status.Sets), status.Refusals))
	return nil
}

func (r *someGuardReports) ReportRefused(shipID string, _ int, refused activity.Activity) error {
	if r.refusedFails > 0 {
		r.refusedFails--
		return errors.New("the fleet does not answer")
	}
	r.reported = append(r.reported, fmt.Sprintf("refused %s %s %s", shipID, refused.At.UTC().Format(time.RFC3339), refused.Tool))
	r.refusedEvents = append(r.refusedEvents, refused)
	return nil
}

var refusedAt = time.Date(2026, 11, 4, 12, 0, 3, 0, time.UTC)

func aGuardStatus(refusals int) guard.Status {
	set, commit := "no-push", "8d41e07aa1"
	status := guard.Status{SettingsVersion: 1, Sets: []guard.AppliedSet{{Name: "no-push", Repository: "fleet/rules", Commit: commit, Floor: true}}, Refusals: refusals, Recent: []guard.RecentRefusal{}}
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

	want := []string{"guard " + scout + " 1 1 sets 2 refusals", "refused " + scout + " 2026-11-04T12:00:03Z Bash", "refused " + scout + " 2026-11-04T12:00:04Z Bash"}
	if !slices.Equal(reports.reported, want) {
		t.Fatalf("reported %q, want %q", reports.reported, want)
	}
}

func TestTheGuardIsReportedOnlyWithTheSettingsVersionItsRulesWereKeptFor(t *testing.T) {
	pass, statuses, reports := aReportingPass(t, aGuardStatus(0))
	next := aGuardStatus(1)
	next.SettingsVersion = 2
	statuses[scout] = next

	pass.run(t)

	if len(reports.reported) != 0 {
		t.Fatalf("reported %q, want nothing under settings version 1 of the rules kept for 2", reports.reported)
	}
}

func TestAGuardReportThatFailedPartlyIsTriedAgainOnlyForWhatTheFleetDidNotTake(t *testing.T) {
	for name, fail := range map[string]func(*someGuardReports){
		"the refused activity": func(r *someGuardReports) { r.refusedFails = 1 },
		"the guard status":     func(r *someGuardReports) { r.guardFails = 1 },
	} {
		t.Run(name, func(t *testing.T) {
			pass, statuses, reports := aReportingPass(t, aGuardStatus(0))
			statuses[scout] = aGuardStatus(1)
			fail(reports)

			pass.run(t)
			pass.run(t)
			pass.run(t)

			slices.Sort(reports.reported)
			want := []string{"guard " + scout + " 1 1 sets 1 refusals", "refused " + scout + " 2026-11-04T12:00:03Z Bash"}
			if !slices.Equal(reports.reported, want) {
				t.Fatalf("reported %q, want each once: %q", reports.reported, want)
			}
		})
	}
}

func TestARefusalReportedButNotKeptAsReportedIsReportedAgainWithTheSameActivity(t *testing.T) {
	pass, statuses, reports := aReportingPass(t, aGuardStatus(0))
	statuses[scout] = aGuardStatus(1)
	saved := reconciler.State{Entries: maps.Clone(pass.store.state.Entries)}
	pass.store.isUnwritable = true
	pass.pass.reportGuards(context.Background(), pass.store.state)
	// The state file holds what it held before the pass.
	pass.store.isUnwritable, pass.store.state.Entries = false, saved.Entries

	pass.run(t)

	if len(reports.refusedEvents) != 2 || reports.refusedEvents[0] != reports.refusedEvents[1] {
		t.Fatalf("refused activities %v, want the same activity reported again", reports.refusedEvents)
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

func TestAnEmptyResolutionDoesNotReportAGuardOrItsOldRefusals(t *testing.T) {
	pass, _ := aGuardedPass(t, someGuardRules{scout: 1})
	empty := aGuardStatus(1)
	empty.Sets = []guard.AppliedSet{}
	reports := &someGuardReports{}
	pass.pass.GuardStatuses, pass.pass.GuardReports = someGuardStatuses{scout: empty}, reports

	pass.crewed(t)
	pass.run(t)

	if len(reports.reported) != 0 {
		t.Fatalf("reported %q, want no guard or refused activity for an empty resolution", reports.reported)
	}
}
