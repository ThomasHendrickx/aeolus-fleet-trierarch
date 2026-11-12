package reconciler

import (
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
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
		Requests:      requests,
		Now:           now,
		Harnesses:     []string{"claude-code"},
		Repositories:  []string{"aeolus-fleet"},
		Folders:       []string{"notes"},
		Trusted:       map[string]Trust{"claude-code": {Repositories: []string{"aeolus-fleet"}, Folders: []string{"notes"}}},
		Configuration: map[string]config.Harness{"claude-code": {Flags: []string{}, Options: map[string]config.Option{}}},
		RunningCap:    2,
		Observed:      Observed{Launches: map[string]LaunchSeen{}},
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

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "harness: This trierarch offers no harness codex"})
	if len(next.Entries) != 0 {
		t.Fatalf("entries: %+v", next.Entries)
	}
}

func TestARequestForAHarnessTheMachineDoesNotOfferIsGivenBackWithWhy(t *testing.T) {
	context := aContext(aRequest(scout))
	context.NotOffered = map[string]string{"claude-code": "its Copilot CLI version is not detected yet"}

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "harness: claude-code is not offered: its Copilot CLI version is not detected yet"})
}

func TestARequestForAHarnessWhosePluginIsMissingIsGivenBackSayingToUpgrade(t *testing.T) {
	context := aContext(aRequest(scout))
	context.MissingPlugins = []string{"claude-code"}

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "harness: claude-code's aeolus-fleet plugin is not installed: run aeolus-trierarch upgrade"})
}

func TestARequestForAHarnessWhosePluginMarksNoLaunchesIsGivenBackSayingToUpgrade(t *testing.T) {
	context := aContext(aRequest(scout))
	context.MarksLaunches = map[string]bool{"claude-code": false}

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "harness: claude-code's aeolus-fleet plugin marks no launches: run aeolus-trierarch upgrade"})
}

func TestAHarnessNotOfferedIsToldBeforeItsPluginIsMissing(t *testing.T) {
	context := aContext(aRequest(scout))
	context.NotOffered = map[string]string{"claude-code": "why"}
	context.MissingPlugins = []string{"claude-code"}
	context.MarksLaunches = map[string]bool{"claude-code": false}

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "harness: claude-code is not offered: why"})
}

func TestAnEntryWhosePluginIsLostUnderItsRunningSessionIsGivenBackSayingToUpgrade(t *testing.T) {
	entry := anEntry(scout, "running")
	other := anEntry("shp_other", "running")
	other.Harness = "codex"
	request, otherRequest := aRequest(scout), aRequest("shp_other")
	request.Status, otherRequest.Status = status("running"), status("running")
	context := aContext(request, otherRequest)
	context.Harnesses = []string{"claude-code", "codex"}
	context.Observed.Sessions = running(scout, "shp_other")
	context.MissingPlugins = []string{"claude-code"}
	context.MarksLaunches = map[string]bool{"codex": true}

	_, actions := Reconcile(withEntries(entry, other), context)

	given := entry
	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "harness: claude-code's aeolus-fleet plugin is not installed: run aeolus-trierarch upgrade", Entry: &given})
}

func TestAnEntryWhosePluginIsLostIsNotGivenBackOnceMoreAtTheVersionRefused(t *testing.T) {
	entry := anEntry(scout, "running")
	state := withEntries(entry)
	state.Refused[scout] = 1
	request := aRequest(scout)
	request.Status = status("running")
	context := aContext(request)
	context.Observed.Sessions = running(scout)
	context.MissingPlugins = []string{"claude-code"}

	_, actions := Reconcile(state, context)

	assertActions(t, actions)
}

func TestARequestAlreadyRefusedAtItsVersionIsNotGivenBackAgain(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Harness = "codex"
	state := Empty()
	state.Refused[scout] = 1

	next, actions := Reconcile(state, aContext(request))

	assertActions(t, actions)
	if next.Refused[scout] != 1 {
		t.Fatalf("refused: %+v", next.Refused)
	}
}

func TestARequestRefusedAtAnEarlierVersionIsGivenBackAtItsNewVersion(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Harness = "codex"
	request.SettingsVersion = 2
	state := Empty()
	state.Refused[scout] = 1

	_, actions := Reconcile(state, aContext(request))

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 2, Reason: "harness: This trierarch offers no harness codex"})
}

func TestARefusalIsForgottenOnceTheRequestIsNoLongerAssigned(t *testing.T) {
	state := Empty()
	state.Refused[scout] = 1

	next, _ := Reconcile(state, aContext())

	if len(next.Refused) != 0 {
		t.Fatalf("refused: %+v", next.Refused)
	}
}

func TestARequestInARepositoryNotConfiguredIsGivenBackWithWhy(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Workspace.Repository = "website"

	_, actions := Reconcile(Empty(), aContext(request))

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "workspace.repository: This trierarch offers no repository website"})
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
	if _, ok := next.Entries[scout]; !ok {
		t.Fatalf("the entry went before its cleanup was carried out")
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
		Action{Kind: Crashed, ShipID: scout, ShipName: "scout", Exits: 6, Key: "trierarch:crashed:" + scout + ":2026-11-04T12:00:00.000Z"},
		Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "crashed", Attempt: 5}},
	)
	if got := next.Entries[scout]; got.State != "crashed" || len(got.Exits) != 6 {
		t.Fatalf("entry: %+v", got)
	}
}

func TestACrashFromAFailedStartTellsWhyItFailed(t *testing.T) {
	entry := anEntry(scout, "running")
	entry.LaunchedAt, entry.LaunchID = ago(time.Minute), "launch-2"
	entry.Exits = []string{ago(50 * time.Minute), ago(40 * time.Minute), ago(30 * time.Minute), ago(20 * time.Minute), ago(10 * time.Minute)}
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = running(scout)
	context.Observed.Launches[scout] = LaunchSeen{Kind: LaunchNone, Cause: "Not logged in"}

	_, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions,
		Action{Kind: Stop, ShipID: scout},
		Action{Kind: Report, ShipID: scout, Note: "blocked: session crashed, restart budget spent"},
		Action{Kind: Crashed, ShipID: scout, ShipName: "scout", Exits: 6, FailedStart: "no activity within a minute of its start, claude-code said: Not logged in", Key: "trierarch:crashed:" + scout + ":2026-11-04T12:00:00.000Z"},
		Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "crashed", Attempt: 5}},
	)
}

func aRefusedLaunch(options map[string]string, model string) (Entry, Context) {
	entry := anEntry(scout, "crewing")
	entry.LaunchedAt, entry.LaunchID, entry.Options = ago(5*time.Second), "launch-1", options
	context := aContext(aRequest(scout))
	context.Observed.Sessions = running(scout)
	context.Observed.Launches[scout] = LaunchSeen{Kind: LaunchRefused, Model: model}
	context.Versions = map[string]string{"claude-code": "2.1.306"}
	return entry, context
}

func TestAModelRefusedTellsArgoThenGivesTheRequestBackAtOnce(t *testing.T) {
	entry, context := aRefusedLaunch(map[string]string{"model": "claude-sonnet-5"}, "claude-sonnet-5")

	next, actions := Reconcile(withEntries(entry), context)

	given := entry
	assertActions(t, actions,
		Action{Kind: ModelRefused, ShipID: scout, ShipName: "scout", Harness: "claude-code", Version: "2.1.306", Model: "claude-sonnet-5"},
		Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "claude-code 2.1.306 refused claude-sonnet-5", Entry: &given},
	)
	if _, ok := next.Entries[scout]; !ok {
		t.Fatalf("the entry went before its cleanup was carried out")
	}
}

func TestAModelRefusedTellsArgoNothingWhenTheSettingsPickedNoModel(t *testing.T) {
	entry, context := aRefusedLaunch(map[string]string{}, "claude-sonnet-5")

	_, actions := Reconcile(withEntries(entry), context)

	given := entry
	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "claude-code 2.1.306 refused claude-sonnet-5", Entry: &given})
}

func TestAModelRefusedTellsArgoNothingWhenTheRefusalNamesNoModelOrTheVersionIsUnknown(t *testing.T) {
	entry, context := aRefusedLaunch(map[string]string{"model": "claude-sonnet-5"}, "")
	_, actions := Reconcile(withEntries(entry), context)
	given := entry
	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "claude-code 2.1.306 refused its default model", Entry: &given})

	entry, context = aRefusedLaunch(map[string]string{"model": "claude-sonnet-5"}, "claude-sonnet-5")
	context.Versions = nil
	_, actions = Reconcile(withEntries(entry), context)
	given = entry
	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "claude-code refused claude-sonnet-5", Entry: &given})
}

func TestAModelRefusedByAFinalCrewIsAFailedStartAgainstTheRestartBudgetAfterTellingArgo(t *testing.T) {
	entry, context := aRefusedLaunch(map[string]string{"model": "claude-sonnet-5"}, "claude-sonnet-5")
	context.Requests[0].IsFinal = true
	context.Requests[0].Status = status("crewing")

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions,
		Action{Kind: ModelRefused, ShipID: scout, ShipName: "scout", Harness: "claude-code", Version: "2.1.306", Model: "claude-sonnet-5"},
		Action{Kind: Stop, ShipID: scout},
		Action{Kind: Report, ShipID: scout, Note: "blocked: session crashed, restarting"},
		Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "restarting", Attempt: 1}},
	)
	if got := next.Entries[scout]; got.State != "restarting" {
		t.Fatalf("entry: %+v", got)
	}
}

func TestAModelRefusedInARestartedSessionsLaunchWindowIsAFailedStartAfterTellingArgo(t *testing.T) {
	entry, context := aRefusedLaunch(map[string]string{"model": "claude-sonnet-5"}, "claude-sonnet-5")
	entry.State = "running"
	context.Requests[0].Status = status("running")

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions,
		Action{Kind: ModelRefused, ShipID: scout, ShipName: "scout", Harness: "claude-code", Version: "2.1.306", Model: "claude-sonnet-5"},
		Action{Kind: Stop, ShipID: scout},
		Action{Kind: Report, ShipID: scout, Note: "blocked: session crashed, restarting"},
		Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "restarting", Attempt: 1}},
	)
	if got := next.Entries[scout]; got.State != "restarting" || got.LaunchedAt != "" {
		t.Fatalf("entry: %+v", got)
	}
}

func TestAShipWhoseFolderHoldsNoIdentityTellsArgoOncePerLoss(t *testing.T) {
	for _, state := range []string{"running", "restarting", "crashed"} {
		entry := anEntry(scout, state)
		context := aContext(aRequest(scout))
		context.Requests[0].Status = status(state)
		context.Observed.Sessions = running(scout)
		context.Observed.WithoutIdentity = []string{scout}

		next, actions := Reconcile(withEntries(entry), context)

		assertActions(t, actions, Action{Kind: IdentityGone, ShipID: scout, ShipName: "scout"})
		if !next.Entries[scout].IsIdentityGone {
			t.Fatalf("%s: the loss was not kept: %+v", state, next.Entries[scout])
		}

		_, again := Reconcile(next, context)
		assertActions(t, again)
	}
}

func TestAShipWhoseIdentityIsBackIsToldAgainOnALaterLoss(t *testing.T) {
	entry := anEntry(scout, "running")
	entry.IsIdentityGone = true
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.Sessions = running(scout)

	back, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions)
	if back.Entries[scout].IsIdentityGone {
		t.Fatalf("the loss stayed: %+v", back.Entries[scout])
	}
	context.Observed.WithoutIdentity = []string{scout}
	_, actions = Reconcile(back, context)
	assertActions(t, actions, Action{Kind: IdentityGone, ShipID: scout, ShipName: "scout"})
}

func TestAShipStillCrewingIsToldNothingOfItsIdentity(t *testing.T) {
	entry := anEntry(scout, "crewing")
	context := aContext(aRequest(scout))
	context.Observed.WithoutIdentity = []string{scout}

	next, _ := Reconcile(withEntries(entry), context)

	if next.Entries[scout].IsIdentityGone {
		t.Fatalf("told while crewing: %+v", next.Entries[scout])
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
	if _, ok := next.Entries[scout]; !ok {
		t.Fatalf("the entry went before its cleanup was carried out")
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

const noKey = "claude-code has no API key on this computer: aeolus-trierarch login claude-code --api-key"

func TestARestartWhoseLoginCannotStartNowStartsNothing(t *testing.T) {
	entry := anEntry(scout, "restarting")
	entry.Exits, entry.RestartAt = []string{ago(10 * time.Minute)}, ago(5*time.Minute)
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("restarting")
	context.Observed.StartProblems = map[string]string{scout: noKey}

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions)
	if got := next.Entries[scout]; got.State != "restarting" || len(got.Exits) != 1 {
		t.Fatalf("entry: %+v, want restarting with its one exit", got)
	}
}

func TestAShipWithNoSessionWhoseLoginCannotStartNowWaitsRestartingWithNoRestartCounted(t *testing.T) {
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.StartProblems = map[string]string{scout: noKey}

	next, actions := Reconcile(withEntries(anEntry(scout, "running")), context)

	assertActions(t, actions, Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "restarting", Attempt: 0}})
	if got := next.Entries[scout]; got.State != "restarting" || len(got.Exits) != 0 {
		t.Fatalf("entry: %+v, want restarting with no exit counted", got)
	}
}

func TestAShipWaitingOnItsLoginStartsOnceItCanWithNoRestartCounted(t *testing.T) {
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("running")
	context.Observed.StartProblems = map[string]string{scout: noKey}
	waiting, _ := Reconcile(withEntries(anEntry(scout, "running")), context)
	later := aContext(aRequest(scout))
	later.Requests[0].Status = status("restarting")
	later.Now = now.Add(time.Minute)

	next, actions := Reconcile(waiting, later)

	assertActions(t, actions, Action{Kind: Launch, ShipID: scout}, Action{Kind: WriteStatus, ShipID: scout, Status: Status{Status: "running", Attempt: 0, StartedAt: now.Add(time.Minute).Format(time.RFC3339Nano)}})
	if got := next.Entries[scout]; got.State != "running" || len(got.Exits) != 0 {
		t.Fatalf("entry: %+v, want running with no exit counted", got)
	}
}

func TestASessionOnAKeyThatIsNotReadyIsHandedNothingForcedOrNot(t *testing.T) {
	for _, seen := range []Seen{{Inbox: Inbox{Waiting: 1}, Turn: TurnIdle, IsKeyNotReady: true}, {Inbox: Inbox{Waiting: 1, Forced: 1}, Turn: TurnBusy, IsKeyNotReady: true}} {
		_, actions := Reconcile(withEntries(anEntry(scout, "running")), aRunningShip(seen))

		assertActions(t, actions)
	}
}

func TestASessionWhoseLeaseEndedIsStoppedAndCrewedAgainAsAFirstStartInAFreshWorktree(t *testing.T) {
	entry := anEntry(scout, "running")
	entry.Exits = []string{ago(time.Minute)}
	next, actions := Reconcile(withEntries(entry), aRunningShip(Seen{Inbox: Inbox{IsLeaseEnded: true}, Turn: TurnIdle}))

	assertActions(t, actions, Action{Kind: Stop, ShipID: scout}, Action{Kind: Crew, ShipID: scout})
	got := next.Entries[scout]
	if got.State != "crewing" || got.Since != now.Format(time.RFC3339Nano) || got.HasStarted || !got.IsReleasedElsewhere || got.Folder != entry.Folder {
		t.Fatalf("entry: %+v", got)
	}
}

func TestACrewWhoseLeaseEndedStaysFinalInTheFleet(t *testing.T) {
	context := aRunningShip(Seen{Inbox: Inbox{IsLeaseEnded: true}, Turn: TurnIdle})
	context.Requests[0].IsFinal = true

	next, actions := Reconcile(withEntries(anEntry(scout, "running")), context)

	assertActions(t, actions, Action{Kind: Stop, ShipID: scout}, Action{Kind: Crew, ShipID: scout})
	if !next.Entries[scout].IsReleasedElsewhere {
		t.Fatalf("entry: %+v", next.Entries[scout])
	}
}

func TestAShipReleasedElsewhereInItsLaunchWindowIsCrewedAgainAtOnce(t *testing.T) {
	entry := anEntry(scout, "crewing")
	entry.LaunchedAt, entry.LaunchID = ago(10*time.Second), "launch-1"
	context := aContext(aRequest(scout))
	context.Requests[0].Status = status("crewing")
	context.Observed.Sessions = running(scout)
	context.Observed.Ships = map[string]Seen{scout: {Inbox: Inbox{IsLeaseEnded: true}, Turn: TurnIdle}}

	next, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions, Action{Kind: Stop, ShipID: scout}, Action{Kind: Crew, ShipID: scout})
	if !next.Entries[scout].IsReleasedElsewhere || next.Entries[scout].HasStarted {
		t.Fatalf("entry: %+v", next.Entries[scout])
	}
}

// underRoot is a folder of aeolus-fleet under the root, by its name.
func underRoot(name string) string {
	return "/worktrees/aeolus-fleet/" + name
}

func assertEmpty(t *testing.T, what string, got []any) {
	t.Helper()
	if !reflect.DeepEqual(got, []any{}) {
		t.Fatalf("%s: got %+v, want none", what, got)
	}
}

func TestEveryFolderUnderTheRootNoEntryWorksInIsRemovedAndNoneIsAnOrphan(t *testing.T) {
	context := aContext()
	context.Observed.Folders = []string{underRoot("stray"), "/worktrees/hemma/notes"}
	state := Empty()
	state.Orphans = []any{map[string]any{"path": underRoot("stray"), "repository": "aeolus-fleet", "name": "stray"}}

	next, actions := Reconcile(state, context)

	assertActions(t, actions, Action{Kind: RemoveStray, Folder: underRoot("stray")}, Action{Kind: RemoveStray, Folder: "/worktrees/hemma/notes"})
	assertEmpty(t, "orphans", next.Orphans)
}

func TestTheFolderAnEntryWorksInOrOneThatHoldsItIsNotRemoved(t *testing.T) {
	request := aRequest(scout)
	request.Status = status("running")
	context := aContext(request)
	context.Observed.Sessions = running(scout)
	entry := anEntry(scout, "running")
	entry.Folder = "/worktrees/aeolus-fleet-designer-release/scout"
	context.Observed.Folders = []string{"/worktrees/aeolus-fleet-designer-release", underRoot("scout")}

	_, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions, Action{Kind: RemoveStray, Folder: underRoot("scout")})
}

func TestEveryFolderInTheFolderAnEntryWorksInIsNotRemovedAndAStrayBesideItIs(t *testing.T) {
	request := aRequest(scout)
	request.Status = status("running")
	context := aContext(request)
	context.Observed.Sessions = running(scout)
	entry := anEntry(scout, "running")
	entry.Folder = "/worktrees/notes"
	context.Observed.Folders = []string{"/worktrees/notes", "/worktrees/notes/src", "/worktrees/notes/src/drafts", "/worktrees/workbench"}

	_, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions, Action{Kind: RemoveStray, Folder: "/worktrees/workbench"})
}

func TestAFolderUnderOneRemovedGoesWithItRemovedOnce(t *testing.T) {
	context := aContext()
	context.Observed.Folders = []string{"/worktrees/workbench", "/worktrees/workbench/tools"}

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: RemoveStray, Folder: "/worktrees/workbench"})
}

func TestTheFolderOfAnEntryForgottenIsNotRemovedAsAStrayAsItsForgetRemovesIt(t *testing.T) {
	context := aContext()
	context.Observed.Folders = []string{underRoot("scout")}
	entry := anEntry(scout, "running")

	_, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions, Action{Kind: Forget, ShipID: scout, Entry: &entry})
}

func TestAWorktreeAnEarlierTrierarchKeptIsRemovedAsAStrayAndNoneIsKept(t *testing.T) {
	context := aContext()
	context.Observed.Folders = []string{underRoot("lookout")}
	state := Empty()
	state.Kept = []any{map[string]any{"shipId": lookout, "repository": "aeolus-fleet", "path": underRoot("lookout")}}

	next, actions := Reconcile(state, context)

	assertActions(t, actions, Action{Kind: RemoveStray, Folder: underRoot("lookout")})
	assertEmpty(t, "kept", next.Kept)
}

func TestEveryClearRequestIsConfirmedNotKeptAsNoWorktreeIsKept(t *testing.T) {
	context := aContext()
	context.Clears = []ClearRequest{{ShipID: lookout, Repository: "aeolus-fleet"}}
	state := Empty()
	state.Kept = []any{map[string]any{"shipId": lookout, "repository": "aeolus-fleet", "path": underRoot("lookout")}}

	_, actions := Reconcile(state, context)

	assertActions(t, actions, Action{Kind: Clear, ShipID: lookout, Repository: "aeolus-fleet"})
}

func TestAShipsFolderAndEveryFolderInItAreNoStrayWhileItsShipHasAnEntryWhereverItsWorkspaceIs(t *testing.T) {
	request := aRequest(scout)
	request.Status = status("running")
	context := aContext(request)
	context.Observed.Sessions = running(scout)
	entry := anEntry(scout, "running")
	entry.Folder, entry.ShipFolder = "/folders/notes", "/ships/"+scout
	context.Observed.Folders = []string{"/ships/" + scout, "/ships/" + scout + "/sockets", "/ships/shp_gone"}

	_, actions := Reconcile(withEntries(entry), context)

	assertActions(t, actions, Action{Kind: RemoveStray, Folder: "/ships/shp_gone"})
}

func TestAShipWhoseShipsFolderIsGoneIsCrewedAgainAsAFirstStartWhateverItsState(t *testing.T) {
	for _, state := range []string{"running", "restarting", "crashed", "crewing"} {
		t.Run(state, func(t *testing.T) {
			entry := anEntry(scout, state)
			entry.ShipFolder = "/ships/" + scout
			request := aRequest(scout)
			request.Status = status("running")
			context := aContext(request)
			context.Observed.ShipFoldersGone = []string{scout}

			next, actions := Reconcile(withEntries(entry), context)

			assertActions(t, actions, Action{Kind: Stop, ShipID: scout}, Action{Kind: Crew, ShipID: scout})
			if again := next.Entries[scout]; !again.IsShipFolderGone || again.HasStarted || again.State != "crewing" {
				t.Fatalf("entry: %+v", again)
			}
		})
	}
}

func TestANewSettingsVersionCrewsTheShipAgainInItsOwnShipsFolder(t *testing.T) {
	entry := anEntry(scout, "running")
	entry.ShipFolder = "/ships/" + scout
	request := aRequest(scout)
	request.SettingsVersion = 2
	context := aContext(request)
	context.Observed.Sessions = running(scout)

	next, _ := Reconcile(withEntries(entry), context)

	if got := next.Entries[scout]; got.ShipFolder != entry.ShipFolder || got.Folder != entry.Folder {
		t.Fatalf("entry: %+v", got)
	}
}
