package reconciler

import (
	"reflect"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/failedstarts"
)

const helm = "shp_01m6jyczpnpp5c0vxh54c966d0"

const configuration = `{"caps":{"ships":8,"running":4}}`

const quiet = "no activity within a minute of its start"

// aQuietStart is the ship's crewing entry whose launch window ended with no activity, and the context that sees it.
func aQuietStart(shipID string, state State) (State, Context) {
	entry := anEntry(shipID, "crewing")
	entry.LaunchedAt, entry.LaunchID = ago(61*time.Second), "launch-1"
	state.Entries[shipID] = entry
	context := aContext(aRequest(shipID))
	context.Configuration = configuration
	context.Observed.Sessions = running(shipID)
	context.Observed.Launches[shipID] = LaunchSeen{Kind: LaunchNone}
	return state, context
}

// failedBefore is the failed starts of the ships, the last of them failing a minute ago.
func failedBefore(shipIDs ...string) *failedstarts.Starts {
	var starts *failedstarts.Starts
	for _, shipID := range shipIDs {
		starts, _ = failedstarts.Count(starts, failedstarts.Outcome{ShipID: shipID, Reason: quiet}, now.Add(-time.Minute), configuration)
	}
	return starts
}

func stoppedOffering(actions []Action) []Action {
	found := []Action{}
	for _, action := range actions {
		if action.Kind == StoppedOffering {
			found = append(found, action)
		}
	}
	return found
}

func TestAStartQuietForItsWholeLaunchWindowIsCountedAsAFailedStartOfItsShip(t *testing.T) {
	state, context := aQuietStart(scout, Empty())

	next, actions := Reconcile(state, context)

	want := &failedstarts.Starts{ShipIDs: []string{scout}, Reason: quiet, At: "2026-11-04T12:00:00.000Z"}
	if !reflect.DeepEqual(next.FailedStarts, want) || len(stoppedOffering(actions)) != 0 {
		t.Fatalf("failed starts: %+v, actions %+v", next.FailedStarts, actions)
	}
}

func TestTheThirdShipWhoseStartFailedStopsTheMachineOfferingItselfAndTellsArgoOnce(t *testing.T) {
	state, context := aQuietStart(helm, Empty())
	state.FailedStarts = failedBefore(scout, lookout)

	next, actions := Reconcile(state, context)

	told := stoppedOffering(actions)
	if len(told) != 1 || next.FailedStarts == nil || next.FailedStarts.Stopped == nil || !reflect.DeepEqual(told[0].FailedStarts, next.FailedStarts) {
		t.Fatalf("failed starts: %+v, actions %+v", next.FailedStarts, actions)
	}
	if next.FailedStarts.Stopped.Since != "2026-11-04T12:00:00.000Z" || next.FailedStarts.Stopped.Configuration != configuration {
		t.Fatalf("stopped: %+v", next.FailedStarts.Stopped)
	}
}

func TestAFailedStartAfterTheStopTellsArgoNothingNew(t *testing.T) {
	state, context := aQuietStart(helm, Empty())
	state.FailedStarts = failedBefore(scout, lookout, "shp_other")

	next, actions := Reconcile(state, context)

	if len(stoppedOffering(actions)) != 0 || len(next.FailedStarts.ShipIDs) != 4 {
		t.Fatalf("failed starts: %+v, actions %+v", next.FailedStarts, actions)
	}
}

func TestAStartActiveInItsLaunchWindowClearsTheFailedStarts(t *testing.T) {
	entry := anEntry(helm, "crewing")
	entry.LaunchedAt, entry.LaunchID = ago(10*time.Second), "launch-1"
	state := withEntries(entry)
	state.FailedStarts = failedBefore(scout, lookout, "shp_other")
	context := aContext(aRequest(helm))
	context.Configuration = configuration
	context.Observed.Sessions = running(helm)
	context.Observed.Launches[helm] = LaunchSeen{Kind: LaunchActive}

	next, _ := Reconcile(state, context)

	if next.FailedStarts != nil {
		t.Fatalf("failed starts: %+v", next.FailedStarts)
	}
}

func TestARestartedSessionActiveInItsLaunchWindowClearsTheFailedStarts(t *testing.T) {
	entry := anEntry(helm, "running")
	entry.LaunchedAt, entry.LaunchID = ago(10*time.Second), "launch-2"
	state := withEntries(entry)
	state.FailedStarts = failedBefore(scout, lookout)
	context := aContext(aRequest(helm))
	context.Requests[0].Status = status("running")
	context.Configuration = configuration
	context.Observed.Sessions = running(helm)
	context.Observed.Launches[helm] = LaunchSeen{Kind: LaunchActive}

	next, _ := Reconcile(state, context)

	if next.FailedStarts != nil {
		t.Fatalf("failed starts: %+v", next.FailedStarts)
	}
}

func TestARestartedSessionQuietForItsWholeLaunchWindowIsCountedAsAFailedStart(t *testing.T) {
	entry := anEntry(helm, "running")
	entry.LaunchedAt, entry.LaunchID = ago(time.Minute), "launch-2"
	state := withEntries(entry)
	state.FailedStarts = failedBefore(scout, lookout)
	context := aContext(aRequest(helm))
	context.Requests[0].Status = status("running")
	context.Configuration = configuration
	context.Observed.Sessions = running(helm)
	context.Observed.Launches[helm] = LaunchSeen{Kind: LaunchNone}

	next, actions := Reconcile(state, context)

	if len(stoppedOffering(actions)) != 1 || next.FailedStarts.Stopped == nil {
		t.Fatalf("failed starts: %+v, actions %+v", next.FailedStarts, actions)
	}
}

func TestAnAnsweredRefusalOfTheHarnessesOwnDefaultModelIsCountedAsAFailedStart(t *testing.T) {
	entry, context := aRefusedLaunch(map[string]string{}, "claude-opus-5-5")
	context.Configuration = configuration

	next, _ := Reconcile(withEntries(entry), context)

	if next.FailedStarts == nil || len(next.FailedStarts.ShipIDs) != 1 || next.FailedStarts.Reason != "claude-code 2.1.306 refused claude-opus-5-5" {
		t.Fatalf("failed starts: %+v", next.FailedStarts)
	}
}

func TestARefusalOfAModelTheSettingsPickedIsNotCountedAgainstTheMachine(t *testing.T) {
	entry, context := aRefusedLaunch(map[string]string{"model": "claude-sonnet-5"}, "claude-sonnet-5")
	context.Configuration = configuration

	next, _ := Reconcile(withEntries(entry), context)

	if next.FailedStarts != nil {
		t.Fatalf("failed starts: %+v", next.FailedStarts)
	}
}

func TestAnotherConfigurationThanTheMachineStoppedWithCountsAfresh(t *testing.T) {
	state := withEntries()
	state.FailedStarts = failedBefore(scout, lookout, helm)
	context := aContext()
	context.Configuration = `{"caps":{"ships":6,"running":4}}`

	next, _ := Reconcile(state, context)

	if next.FailedStarts != nil {
		t.Fatalf("failed starts: %+v", next.FailedStarts)
	}
}

func TestTheFailedStartsStayWhileNoStartDecides(t *testing.T) {
	state := withEntries()
	state.FailedStarts = failedBefore(scout, lookout, helm)
	context := aContext()
	context.Configuration = configuration

	next, actions := Reconcile(state, context)

	if !reflect.DeepEqual(next.FailedStarts, state.FailedStarts) || len(actions) != 0 {
		t.Fatalf("failed starts: %+v, actions %+v", next.FailedStarts, actions)
	}
}
