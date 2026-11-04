package reconciler

import (
	"reflect"
	"testing"
	"time"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"
const lookout = "shp_01m6jyczpnpp5c0vxh54c966cz"

var now = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

func ago(duration time.Duration) string {
	return now.Add(-duration).Format(time.RFC3339Nano)
}

func status(text string) *string {
	return &text
}

// aRequest is a crew request for the ship with Claude Code in a worktree of aeolus-fleet, version 1, not final.
func aRequest(shipID string) Request {
	return Request{ShipID: shipID, SettingsVersion: 1, Settings: Settings{Harness: "claude-code", Workspace: Workspace{Kind: "worktree", Repository: "aeolus-fleet"}, Options: map[string]string{}}}
}

// anEntry is the ship's entry in the state given, crewed from aRequest, its session started in its worktree.
func anEntry(shipID string, state string) Entry {
	return Entry{ShipID: shipID, ShipName: "scout", SettingsVersion: 1, Harness: "claude-code", Workspace: Workspace{Kind: "worktree", Repository: "aeolus-fleet"}, Options: map[string]string{}, State: state, Since: ago(time.Hour), Exits: []string{}, Folder: "/worktrees/aeolus-fleet/scout", CrewToken: "aeolus_ct_v1_scout", HasStarted: true}
}

func aContext(requests ...Request) Context {
	return Context{
		Requests:     requests,
		Now:          now,
		Harnesses:    []string{"claude-code"},
		Repositories: []string{"aeolus-fleet"},
		RunningCap:   2,
		Observed:     Observed{Launches: map[string]LaunchSeen{}},
	}
}

func withEntries(entries ...Entry) State {
	state := Empty()
	for _, entry := range entries {
		state.Entries[entry.ShipID] = entry
	}
	return state
}

func running(shipIDs ...string) []Session {
	sessions := []Session{}
	for _, shipID := range shipIDs {
		sessions = append(sessions, Session{ShipID: shipID, Status: SessionRunning})
	}
	return sessions
}

func assertActions(t *testing.T, got []Action, want ...Action) {
	t.Helper()
	if want == nil {
		want = []Action{}
	}
	if got == nil {
		got = []Action{}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("actions:\n got  %+v\n want %+v", got, want)
	}
}

func TestANewRequestIsSavedCrewingAndCrewed(t *testing.T) {
	next, actions := Reconcile(Empty(), aContext(aRequest(scout)))

	assertActions(t, actions, Action{Kind: Crew, ShipID: scout})
	entry := next.Entries[scout]
	if entry.State != "crewing" || entry.Since != now.Format(time.RFC3339Nano) || entry.Harness != "claude-code" || entry.Workspace.Repository != "aeolus-fleet" || entry.HasStarted {
		t.Fatalf("entry: %+v", entry)
	}
}

func TestANewRequestWaitsWhileTheRunningCapIsReached(t *testing.T) {
	context := aContext(aRequest(lookout), aRequest(scout))
	context.RunningCap = 1
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = running(lookout)

	next, actions := Reconcile(withEntries(anEntry(lookout, "running")), context)

	assertActions(t, actions)
	if _, ok := next.Entries[scout]; ok {
		t.Fatalf("scout was saved while the cap was reached")
	}
}

func TestANewRequestTakesTheLastPlaceUnderTheRunningCap(t *testing.T) {
	context := aContext(aRequest(lookout), aRequest(scout))
	context.RunningCap = 2
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = running(lookout)

	_, actions := Reconcile(withEntries(anEntry(lookout, "running")), context)

	assertActions(t, actions, Action{Kind: Crew, ShipID: scout})
}

func TestARequestForAHarnessNotOfferedIsGivenBackWithWhy(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Harness = "codex"

	next, actions := Reconcile(Empty(), aContext(request))

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "harness: codex is not offered on this machine"})
	if len(next.Entries) != 0 {
		t.Fatalf("entries: %+v", next.Entries)
	}
}

func TestARequestInARepositoryNotConfiguredIsGivenBackWithWhy(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Workspace.Repository = "website"

	_, actions := Reconcile(Empty(), aContext(request))

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "workspace.repository: website is not configured on this machine"})
}

func TestARequestWithoutAHarnessTakesTheFirstOffered(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Harness = ""

	next, actions := Reconcile(Empty(), aContext(request))

	assertActions(t, actions, Action{Kind: Crew, ShipID: scout})
	if next.Entries[scout].Harness != "claude-code" {
		t.Fatalf("harness: %q", next.Entries[scout].Harness)
	}
}

func TestAFinalRequestItCannotCrewIsNotGivenBack(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Harness = "codex"
	request.IsFinal = true

	_, actions := Reconcile(Empty(), aContext(request))

	assertActions(t, actions)
}

func TestACrewingEntryWithNoSessionIsCrewedAgain(t *testing.T) {
	entry := anEntry(scout, "crewing")

	_, actions := Reconcile(withEntries(entry), aContext(aRequest(scout)))

	assertActions(t, actions, Action{Kind: Crew, ShipID: scout, IsResumed: true})
}

func TestACrewingSessionActiveInItsLaunchWindowRunsSinceItStarted(t *testing.T) {
	entry := anEntry(scout, "crewing")
	entry.LaunchedAt, entry.LaunchID = ago(10*time.Second), "launch-1"
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("crewing")
	context.Observed.Sessions = running(scout)
	context.Observed.Launches[scout] = LaunchSeen{Kind: LaunchActive}

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions, Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "running", Attempt: 0, StartedAt: ago(10 * time.Second)}})
	got := next.Entries[scout]
	if got.State != "running" || got.Since != ago(10*time.Second) || got.LaunchedAt != "" || got.LaunchID != "" {
		t.Fatalf("entry: %+v", got)
	}
}

func TestACrewingSessionStillQuietInItsLaunchWindowWaits(t *testing.T) {
	entry := anEntry(scout, "crewing")
	entry.LaunchedAt, entry.LaunchID = ago(59*time.Second), "launch-1"
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("crewing")
	context.Observed.Sessions = running(scout)
	context.Observed.Launches[scout] = LaunchSeen{Kind: LaunchNone}

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions)
	if next.Entries[scout].State != "crewing" {
		t.Fatalf("entry: %+v", next.Entries[scout])
	}
}

func TestACrewingSessionQuietForItsWholeLaunchWindowIsGivenBack(t *testing.T) {
	entry := anEntry(scout, "crewing")
	entry.LaunchedAt, entry.LaunchID = ago(60*time.Second), "launch-1"
	context := aContext(aRequest(scout))
	context.Observed.Sessions = running(scout)
	context.Observed.Launches[scout] = LaunchSeen{Kind: LaunchNone, Cause: "Not logged in"}

	next, actions := Reconcile(withEntries(entry), context)

	given := entry
	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "no activity within a minute of its start, claude-code said: Not logged in", Entry: &given})
	if _, ok := next.Entries[scout]; ok {
		t.Fatalf("the entry stayed: %+v", next.Entries[scout])
	}
}

func TestAFinalCrewQuietForItsWholeLaunchWindowRestartsAgainstItsBudget(t *testing.T) {
	entry := anEntry(scout, "crewing")
	entry.LaunchedAt, entry.LaunchID = ago(61*time.Second), "launch-1"
	context := aContext(aRequest(scout))
	context.Requests[0].IsFinal = true
	context.Requests[0].Status = status("crewing")
	context.Observed.Sessions = running(scout)
	context.Observed.Launches[scout] = LaunchSeen{Kind: LaunchNone}

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions,
		Action{Kind: Stop, ShipID: scout},
		Action{Kind: Report, ShipID: scout, Note: "blocked: session crashed, restarting"},
		Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "restarting", Attempt: 1}},
	)
	got := next.Entries[scout]
	if got.State != "restarting" || got.RestartAt != now.Add(5*time.Second).Format(time.RFC3339Nano) || !reflect.DeepEqual(got.Exits, []string{now.Format(time.RFC3339Nano)}) {
		t.Fatalf("entry: %+v", got)
	}
}

func TestARunningEntryWhoseSessionIsGoneStartsAgainWithNoRestartCounted(t *testing.T) {
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")

	next, actions := Reconcile(withEntries(anEntry(scout, "running")), context)

	assertActions(t, actions, Action{Kind: Launch, ShipID: scout})
	if got := next.Entries[scout]; got.State != "running" || len(got.Exits) != 0 {
		t.Fatalf("entry: %+v", got)
	}
}

func TestARunningEntryWhoseSessionRunsIsLeftAlone(t *testing.T) {
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = running(scout)

	_, actions := Reconcile(withEntries(anEntry(scout, "running")), context)

	assertActions(t, actions)
}

func TestASessionThatExitedRestartsAfterFiveSeconds(t *testing.T) {
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = []Session{{ShipID: scout, Status: SessionExited}}

	next, actions := Reconcile(withEntries(anEntry(scout, "running")), context)

	assertActions(t, actions,
		Action{Kind: Report, ShipID: scout, Note: "blocked: session crashed, restarting"},
		Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "restarting", Attempt: 1}},
	)
	got := next.Entries[scout]
	if got.State != "restarting" || got.RestartAt != now.Add(5*time.Second).Format(time.RFC3339Nano) || len(got.Exits) != 1 {
		t.Fatalf("entry: %+v", got)
	}
}

func TestASessionThatExitedAgainWaitsLongerEachTime(t *testing.T) {
	entry := anEntry(scout, "running")
	entry.Exits = []string{ago(50 * time.Minute), ago(40 * time.Minute), ago(30 * time.Minute)}
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = []Session{{ShipID: scout, Status: SessionExited}}

	next, _ := Reconcile(withEntries(entry), context)

	if got := next.Entries[scout].RestartAt; got != now.Add(10*time.Minute).Format(time.RFC3339Nano) {
		t.Fatalf("restartAt: %s", got)
	}
}

func TestASessionThatExitedASixthTimeWithinTheHourIsCrashed(t *testing.T) {
	entry := anEntry(scout, "running")
	entry.Exits = []string{ago(50 * time.Minute), ago(40 * time.Minute), ago(30 * time.Minute), ago(20 * time.Minute), ago(10 * time.Minute)}
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = []Session{{ShipID: scout, Status: SessionExited}}

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions,
		Action{Kind: Stop, ShipID: scout},
		Action{Kind: Report, ShipID: scout, Note: "blocked: session crashed, restart budget spent"},
		Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "crashed", Attempt: 5}},
	)
	if got := next.Entries[scout]; got.State != "crashed" || len(got.Exits) != 6 {
		t.Fatalf("entry: %+v", got)
	}
}

func TestAnExitOlderThanAnHourCountsNoMore(t *testing.T) {
	entry := anEntry(scout, "running")
	entry.Exits = []string{ago(61 * time.Minute), ago(50 * time.Minute), ago(40 * time.Minute), ago(30 * time.Minute), ago(20 * time.Minute)}
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = []Session{{ShipID: scout, Status: SessionExited}}

	next, _ := Reconcile(withEntries(entry), context)

	if got := next.Entries[scout]; got.State != "restarting" || len(got.Exits) != 5 {
		t.Fatalf("entry: %+v", got)
	}
}

func TestARestartingEntryStartsAgainOnceItsWaitIsOver(t *testing.T) {
	entry := anEntry(scout, "restarting")
	entry.Exits, entry.RestartAt = []string{ago(5 * time.Second)}, now.Format(time.RFC3339Nano)
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("restarting")

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions, Action{Kind: Launch, ShipID: scout}, Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "running", Attempt: 1, StartedAt: now.Format(time.RFC3339Nano)}})
	if got := next.Entries[scout]; got.State != "running" || len(got.Exits) != 1 {
		t.Fatalf("entry: %+v", got)
	}
}

func TestARestartingEntryWaitsUntilItsTime(t *testing.T) {
	entry := anEntry(scout, "restarting")
	entry.Exits, entry.RestartAt = []string{ago(4 * time.Second)}, now.Add(time.Second).Format(time.RFC3339Nano)
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("restarting")

	_, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions)
}

func TestARestartedSessionQuietForItsWholeLaunchWindowIsAFailedStart(t *testing.T) {
	entry := anEntry(scout, "running")
	entry.LaunchedAt, entry.LaunchID = ago(time.Minute), "launch-2"
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = running(scout)
	context.Observed.Launches[scout] = LaunchSeen{Kind: LaunchNone}

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions,
		Action{Kind: Stop, ShipID: scout},
		Action{Kind: Report, ShipID: scout, Note: "blocked: session crashed, restarting"},
		Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "restarting", Attempt: 1}},
	)
	if got := next.Entries[scout]; got.State != "restarting" {
		t.Fatalf("entry: %+v", got)
	}
}

func TestARestartedSessionActiveClosesItsLaunchWindow(t *testing.T) {
	entry := anEntry(scout, "running")
	entry.LaunchedAt, entry.LaunchID = ago(10*time.Second), "launch-2"
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = running(scout)
	context.Observed.Launches[scout] = LaunchSeen{Kind: LaunchActive}

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions)
	if got := next.Entries[scout]; got.LaunchedAt != "" || got.State != "running" {
		t.Fatalf("entry: %+v", got)
	}
}

func TestARemovedRequestItCrewsIsReleased(t *testing.T) {
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("releasing")
	context.Observed.Sessions = running(scout)

	next, actions := Reconcile(withEntries(anEntry(scout, "running")), context)

	assertActions(t, actions, Action{Kind: Release, ShipID: scout})
	if _, ok := next.Entries[scout]; !ok {
		t.Fatalf("the entry went before its release was carried out")
	}
}

func TestARemovedRequestItDoesNotCrewIsConfirmedAlone(t *testing.T) {
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("releasing")

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: Confirm, ShipID: scout})
}

func TestAnEntryWhoseRequestIsNoLongerAssignedHereIsForgotten(t *testing.T) {
	entry := anEntry(scout, "running")

	next, actions := Reconcile(withEntries(entry), aContext())

	assertActions(t, actions, Action{Kind: Forget, ShipID: scout, Entry: &entry})
	if len(next.Entries) != 0 {
		t.Fatalf("entries: %+v", next.Entries)
	}
}

func TestASessionOfNoEntryIsStopped(t *testing.T) {
	context := aContext()
	context.Observed.Sessions = running(lookout)

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: Stop, ShipID: lookout})
}

func TestANewSettingsVersionCrewsTheShipAgainInItsFolderAsAFirstStart(t *testing.T) {
	entry := anEntry(scout, "running")
	entry.Exits = []string{ago(time.Minute)}
	request := aRequest(scout)
	request.SettingsVersion = 2
	request.Settings.FirstPrompt = "Review PR 12"
	context := aContext(request)
	context.Observed.Sessions = running(scout)

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions, Action{Kind: Stop, ShipID: scout}, Action{Kind: Crew, ShipID: scout, IsResumed: true})
	got := next.Entries[scout]
	if got.SettingsVersion != 2 || got.State != "crewing" || got.Folder != entry.Folder || got.ShipName != "scout" || got.HasStarted || len(got.Exits) != 0 || got.FirstPrompt != "Review PR 12" {
		t.Fatalf("entry: %+v", got)
	}
}

func TestACrashedEntryWaitsForAHuman(t *testing.T) {
	entry := anEntry(scout, "crashed")
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("crashed")

	_, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions)
}

// aRunningShip is the context of the ship's entry running with its session, its inbox and turn as seen.
func aRunningShip(seen Seen) Context {
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = running(scout)
	context.Observed.Ships = map[string]Seen{scout: seen}
	return context
}

func TestAnIdleSessionIsHandedAMessageWhileDeliveriesWait(t *testing.T) {
	_, actions := Reconcile(withEntries(anEntry(scout, "running")), aRunningShip(Seen{Inbox: Inbox{Waiting: 1}, Turn: TurnIdle}))

	assertActions(t, actions, Action{Kind: Wake, ShipID: scout})
}

func TestAnIdleSessionIsHandedAMessageItsStoreHolds(t *testing.T) {
	_, actions := Reconcile(withEntries(anEntry(scout, "running")), aRunningShip(Seen{Inbox: Inbox{}, Turn: TurnIdle, IsHolding: true}))

	assertActions(t, actions, Action{Kind: Wake, ShipID: scout})
}

func TestAnIdleSessionWithNothingWaitingIsHandedNothing(t *testing.T) {
	_, actions := Reconcile(withEntries(anEntry(scout, "running")), aRunningShip(Seen{Inbox: Inbox{}, Turn: TurnIdle}))

	assertActions(t, actions)
}

func TestABusyOrUnknownTurnIsHandedNothingThatIsNotForced(t *testing.T) {
	for _, turn := range []string{TurnBusy, TurnUnknown} {
		t.Run(turn, func(t *testing.T) {
			_, actions := Reconcile(withEntries(anEntry(scout, "running")), aRunningShip(Seen{Inbox: Inbox{Waiting: 2}, Turn: turn, IsHolding: true}))

			assertActions(t, actions)
		})
	}
}

func TestAForcedMessageIsHandedOverIdleOrBusy(t *testing.T) {
	cases := []struct {
		turn       string
		isTurnBusy bool
	}{{TurnIdle, false}, {TurnBusy, true}}
	for _, c := range cases {
		t.Run(c.turn, func(t *testing.T) {
			_, actions := Reconcile(withEntries(anEntry(scout, "running")), aRunningShip(Seen{Inbox: Inbox{Waiting: 2, Forced: 1}, Turn: c.turn}))

			assertActions(t, actions, Action{Kind: Force, ShipID: scout, IsTurnBusy: c.isTurnBusy})
		})
	}
}

func TestAForcedMessageWaitsWhileTheTurnIsUnknown(t *testing.T) {
	_, actions := Reconcile(withEntries(anEntry(scout, "running")), aRunningShip(Seen{Inbox: Inbox{Waiting: 1, Forced: 1}, Turn: TurnUnknown}))

	assertActions(t, actions)
}

func TestASessionWhoseLeaseEndedIsHandedNothing(t *testing.T) {
	_, actions := Reconcile(withEntries(anEntry(scout, "running")), aRunningShip(Seen{Inbox: Inbox{IsLeaseEnded: true}, Turn: TurnIdle, IsHolding: true}))

	assertActions(t, actions)
}

func TestAnUnwatchedSessionIsHandedNothing(t *testing.T) {
	_, actions := Reconcile(withEntries(anEntry(scout, "running")), aRunningShip(Seen{}))

	assertActions(t, actions)
}

func TestASessionInItsLaunchWindowIsHandedAMessage(t *testing.T) {
	for _, state := range []string{"crewing", "running"} {
		t.Run(state, func(t *testing.T) {
			entry := anEntry(scout, state)
			entry.LaunchedAt, entry.LaunchID = ago(10*time.Second), "launch-1"
			context := aRunningShip(Seen{Inbox: Inbox{Waiting: 1}, Turn: TurnIdle})
			context.Requests[0].Status = status(state)
			context.Observed.Launches[scout] = LaunchSeen{Kind: LaunchNone}

			_, actions := Reconcile(withEntries(entry), context)

			assertActions(t, actions, Action{Kind: Wake, ShipID: scout})
		})
	}
}

func TestASessionActiveAtTheEndOfItsLaunchIsHandedAMessage(t *testing.T) {
	entry := anEntry(scout, "crewing")
	entry.LaunchedAt, entry.LaunchID = ago(10*time.Second), "launch-1"
	context := aRunningShip(Seen{Inbox: Inbox{Waiting: 1}, Turn: TurnIdle})
	context.Requests[0].Status = status("crewing")
	context.Observed.Launches[scout] = LaunchSeen{Kind: LaunchActive}

	_, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions, Action{Kind: Wake, ShipID: scout}, Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "running", Attempt: 0, StartedAt: ago(10 * time.Second)}})
}

func TestASessionOfAnotherVersionIsStartedAgainOnceItsTurnIsIdleWithNoRestartCounted(t *testing.T) {
	context := aRunningShip(Seen{Inbox: Inbox{Waiting: 1, Forced: 1}, Turn: TurnIdle})
	context.Observed.Sessions[0].IsOtherVersion = true

	next, actions := Reconcile(withEntries(anEntry(scout, "running")), context)

	assertActions(t, actions, Action{Kind: Launch, ShipID: scout})
	if got := next.Entries[scout]; len(got.Exits) != 0 || got.State != "running" {
		t.Fatalf("entry = %+v, want running with no exit counted", got)
	}
}

func TestASessionOfAnotherVersionIsHandedNothingWhileItsTurnIsBusy(t *testing.T) {
	context := aRunningShip(Seen{Inbox: Inbox{Waiting: 1, Forced: 1}, Turn: TurnBusy})
	context.Observed.Sessions[0].IsOtherVersion = true

	_, actions := Reconcile(withEntries(anEntry(scout, "running")), context)

	assertActions(t, actions)
}
