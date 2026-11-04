package runpass

import (
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"

var now = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

// aFleet holds the requests assigned to the trierarch and its ships, and writes down every call it was made.
type aFleet struct {
	requests []reconciler.Request
	ships    map[string]fleet.Ship
	calls    []string
	refuse   string
}

func (f *aFleet) call(text string) error {
	f.calls = append(f.calls, text)
	if f.refuse != "" && strings.HasPrefix(text, f.refuse) {
		return errors.New("the fleet refused " + text)
	}
	return nil
}
func (f *aFleet) AssignedRequests() ([]reconciler.Request, error) { return f.requests, nil }
func (f *aFleet) Ship(shipID string) (fleet.Ship, error) {
	if ship, ok := f.ships[shipID]; ok {
		return ship, nil
	}
	return fleet.Ship{Status: "notFound"}, nil
}
func (f *aFleet) StartingSecret(shipID string) (string, error) {
	return "aeolus_sk_v1_" + shipID, f.call("getStartingPrompt " + shipID)
}
func (f *aFleet) RegisterShip(shipID string, secret string, harness string) (string, error) {
	return "aeolus_ct_v1_scout", f.call(fmt.Sprintf("register %s %s %s", shipID, secret, harness))
}
func (f *aFleet) Release(shipID string) error        { return f.call("release " + shipID) }
func (f *aFleet) ConfirmRelease(shipID string) error { return f.call("confirm " + shipID) }
func (f *aFleet) WriteStatus(shipID string, status string, attempt int, startedAt string) error {
	return f.call(fmt.Sprintf("status %s %s %d %s", shipID, status, attempt, startedAt))
}
func (f *aFleet) GiveBack(shipID string, settingsVersion int, reason string) error {
	return f.call(fmt.Sprintf("giveBack %s %d %s", shipID, settingsVersion, reason))
}
func (f *aFleet) ReportFor(crewToken string, state string, note string) error {
	return f.call(fmt.Sprintf("report %s %s %s", crewToken, state, note))
}

// aSessions holds the sessions that run, as the harness's launches start them.
type aSessions struct {
	observed []sessions.Observed
	stopped  []string
}

func (s *aSessions) List() ([]sessions.Observed, error) { return s.observed, nil }
func (s *aSessions) Stop(shipID string) error {
	s.stopped = append(s.stopped, shipID)
	s.observed = slices.DeleteFunc(s.observed, func(each sessions.Observed) bool { return each.ShipID == shipID })
	return nil
}

type launched struct {
	shipID       string
	folder       string
	isFirstStart bool
	launchID     string
	firstPrompt  string
}

// aHarness keeps identities by folder and the launches it made, and says each launch as the marker would.
type aHarness struct {
	sessions   *aSessions
	identities map[string]plugin.Identity
	tokens     map[string]string
	launches   []launched
	died       []string
	seen       map[string]reconciler.LaunchSeen
	problem    error
}

func (h *aHarness) Launch(entry reconciler.Entry, isFirstStart bool, launchID string) error {
	h.launches = append(h.launches, launched{shipID: entry.ShipID, folder: entry.Folder, isFirstStart: isFirstStart, launchID: launchID, firstPrompt: entry.FirstPrompt})
	h.sessions.observed = append(h.sessions.observed, sessions.Observed{ShipID: entry.ShipID, Status: "running"})
	return nil
}
func (h *aHarness) LaunchSeen(entry reconciler.Entry) reconciler.LaunchSeen {
	if seen, ok := h.seen[entry.ShipID]; ok {
		return seen
	}
	return reconciler.LaunchSeen{Kind: reconciler.LaunchNone}
}
func (h *aHarness) WriteIdentity(folder string, identity plugin.Identity, crewToken string) error {
	h.identities[folder], h.tokens[folder] = identity, crewToken
	return nil
}
func (h *aHarness) HasIdentity(folder string) bool {
	_, ok := h.identities[folder]
	return ok
}
func (h *aHarness) DeleteIdentity(folder string) error {
	delete(h.identities, folder)
	return nil
}
func (h *aHarness) SessionDied(folder string) error {
	h.died = append(h.died, folder)
	return nil
}
func (h *aHarness) Problem() error { return h.problem }

// aWorkspace makes each worktree as a folder that holds what the test puts in it.
type aWorkspace struct {
	made    map[string]bool
	unsaved map[string][]string
	removed []string
}

func (w *aWorkspace) Prepare(entry reconciler.Entry, shipName string) (string, error) {
	folder := "/worktrees/" + entry.Workspace.Repository + "/" + shipName
	w.made[folder] = true
	return folder, nil
}
func (w *aWorkspace) Unsaved(folder string) ([]string, error) { return w.unsaved[folder], nil }
func (w *aWorkspace) Remove(entry reconciler.Entry) error {
	delete(w.made, entry.Folder)
	w.removed = append(w.removed, entry.Folder)
	return nil
}

type aStore struct {
	state reconciler.State
	saves int
}

func (s *aStore) Load() (reconciler.State, error)   { return s.state, nil }
func (s *aStore) Save(state reconciler.State) error { s.state, s.saves = state, s.saves+1; return nil }

type aPass struct {
	fleet     *aFleet
	sessions  *aSessions
	harness   *aHarness
	workspace *aWorkspace
	store     *aStore
	logged    []string
	pass      Pass
}

func aRunPass(t *testing.T) *aPass {
	t.Helper()
	running := &aSessions{}
	at := &aPass{
		fleet:     &aFleet{ships: map[string]fleet.Ship{scout: {Name: "scout", Status: "awaitingCrew"}}},
		sessions:  running,
		harness:   &aHarness{sessions: running, identities: map[string]plugin.Identity{}, tokens: map[string]string{}, seen: map[string]reconciler.LaunchSeen{}},
		workspace: &aWorkspace{made: map[string]bool{}, unsaved: map[string][]string{}},
		store:     &aStore{state: reconciler.Empty()},
	}
	launches := 0
	at.pass = Pass{
		Fleet:        at.fleet,
		Sessions:     at.sessions,
		Harnesses:    map[string]Harness{"claude-code": at.harness},
		Workspace:    at.workspace,
		Store:        at.store,
		Log:          func(line string) { at.logged = append(at.logged, line) },
		Now:          func() time.Time { return now },
		NewLaunchID:  func() string { launches++; return fmt.Sprintf("launch-%d", launches) },
		FleetURL:     "https://fleet.example",
		Sockets:      "/home/me/.aeolus/trierarch/sockets",
		Offered:      []string{"claude-code"},
		Repositories: []string{"aeolus-fleet"},
		RunningCap:   2,
	}
	return at
}

func aRequest(status string) reconciler.Request {
	request := reconciler.Request{ShipID: scout, SettingsVersion: 1, Settings: reconciler.Settings{Harness: "claude-code", Workspace: reconciler.Workspace{Kind: "worktree", Repository: "aeolus-fleet"}, FirstPrompt: "Review PR 12"}}
	if status != "" {
		request.Status = &status
	}
	return request
}

func (p *aPass) run(t *testing.T) {
	t.Helper()
	if err := p.pass.Run(); err != nil {
		t.Fatalf("pass: %v", err)
	}
}

// crewed runs passes until scout runs: crewed, then active in its launch window.
func (p *aPass) crewed(t *testing.T) {
	t.Helper()
	p.fleet.requests = []reconciler.Request{aRequest("")}
	p.run(t)
	p.harness.seen[scout] = reconciler.LaunchSeen{Kind: reconciler.LaunchActive}
	p.fleet.requests = []reconciler.Request{aRequest("crewing")}
	p.run(t)
	p.fleet.ships[scout] = fleet.Ship{Name: "scout", Status: "crewed"}
	p.fleet.requests = []reconciler.Request{aRequest("running")}
	p.fleet.calls = nil
}

func TestACrewIsRegisteredWithTheStartingPromptsSecretAndItsSessionStartsInItsWorktree(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	want := []string{"status " + scout + " crewing 0 ", "getStartingPrompt " + scout, "register " + scout + " aeolus_sk_v1_" + scout + " claude-code"}
	if !slices.Equal(pass.fleet.calls, want) {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
	folder := "/worktrees/aeolus-fleet/scout"
	identity := pass.harness.identities[folder]
	if identity.ShipID != scout || identity.ShipName != "scout" || identity.FleetURL != "https://fleet.example" || identity.Socket != "/home/me/.aeolus/trierarch/sockets/"+scout+"/fleet.sock" || pass.harness.tokens[folder] != "aeolus_ct_v1_scout" {
		t.Fatalf("identity %+v, token %q", identity, pass.harness.tokens[folder])
	}
	if len(pass.harness.launches) != 1 || pass.harness.launches[0] != (launched{shipID: scout, folder: folder, isFirstStart: true, launchID: "launch-1", firstPrompt: "Review PR 12"}) {
		t.Fatalf("launches %+v", pass.harness.launches)
	}
}

func TestACrewKeepsItsCrewTokenFolderAndLaunchInTheState(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	entry := pass.store.state.Entries[scout]
	if entry.State != "crewing" || entry.CrewToken != "aeolus_ct_v1_scout" || entry.Folder != "/worktrees/aeolus-fleet/scout" || entry.ShipName != "scout" || !entry.HasStarted || entry.LaunchID != "launch-1" || entry.LaunchedAt != now.Format(time.RFC3339Nano) {
		t.Fatalf("entry %+v", entry)
	}
}

func TestACrewThatIsActiveInItsLaunchWindowRuns(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.requests = []reconciler.Request{aRequest("")}
	pass.run(t)
	pass.harness.seen[scout] = reconciler.LaunchSeen{Kind: reconciler.LaunchActive}
	pass.fleet.requests = []reconciler.Request{aRequest("crewing")}
	pass.fleet.calls = nil

	pass.run(t)

	if !slices.Equal(pass.fleet.calls, []string{"status " + scout + " running 0 " + now.Format(time.RFC3339Nano)}) {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
	if pass.store.state.Entries[scout].State != "running" {
		t.Fatalf("entry %+v", pass.store.state.Entries[scout])
	}
}

func TestAShipCrewedByAnotherSessionIsLeft(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.ships[scout] = fleet.Ship{Name: "scout", Status: "crewed"}
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if len(pass.fleet.calls) != 0 || len(pass.harness.launches) != 0 || len(pass.store.state.Entries) != 0 {
		t.Fatalf("calls %q, launches %+v, entries %+v", pass.fleet.calls, pass.harness.launches, pass.store.state.Entries)
	}
}

func TestACrewWhoseHarnessCannotStartIsGivenBackBeforeItRegisters(t *testing.T) {
	pass := aRunPass(t)
	pass.harness.problem = errors.New("the aeolus-fleet plugin's scripts are not at /plugin/scripts")
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 the aeolus-fleet plugin's scripts are not at /plugin/scripts") || slices.ContainsFunc(pass.fleet.calls, func(call string) bool { return strings.HasPrefix(call, "register") }) {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
	if len(pass.store.state.Entries) != 0 {
		t.Fatalf("entries %+v", pass.store.state.Entries)
	}
}

func TestASessionThatExitedStartsAgainContinuingOnceItsWaitIsOver(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited"}}
	pass.run(t)
	pass.fleet.requests = []reconciler.Request{aRequest("restarting")}
	pass.pass.Now = func() time.Time { return now.Add(5 * time.Second) }

	pass.run(t)

	last := pass.harness.launches[len(pass.harness.launches)-1]
	if len(pass.harness.launches) != 2 || last.isFirstStart || last.launchID != "launch-2" {
		t.Fatalf("launches %+v", pass.harness.launches)
	}
	if !slices.Equal(pass.harness.died, []string{"/worktrees/aeolus-fleet/scout"}) {
		t.Fatalf("died %q", pass.harness.died)
	}
	if entry := pass.store.state.Entries[scout]; entry.State != "running" || len(entry.Exits) != 1 {
		t.Fatalf("entry %+v", entry)
	}
}

func TestARestartIsReportedOnTheShipsBehalf(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited"}}

	pass.run(t)

	if !slices.Equal(pass.fleet.calls, []string{"report aeolus_ct_v1_scout blocked blocked: session crashed, restarting", "status " + scout + " restarting 1 "}) {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
}

func TestAReleaseStopsTheSessionEndsTheLeaseRemovesTheWorktreeThenConfirms(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.fleet.requests = []reconciler.Request{aRequest("releasing")}

	pass.run(t)

	if !slices.Equal(pass.sessions.stopped, []string{scout}) || !slices.Equal(pass.fleet.calls, []string{"release " + scout, "confirm " + scout}) {
		t.Fatalf("stopped %q, calls %q", pass.sessions.stopped, pass.fleet.calls)
	}
	if !slices.Equal(pass.workspace.removed, []string{"/worktrees/aeolus-fleet/scout"}) || pass.harness.HasIdentity("/worktrees/aeolus-fleet/scout") {
		t.Fatalf("removed %q, identities %+v", pass.workspace.removed, pass.harness.identities)
	}
	if len(pass.store.state.Entries) != 0 {
		t.Fatalf("entries %+v", pass.store.state.Entries)
	}
}

func TestAReleaseLogsWhatItsWorktreeHeldAndRemovesItAnyway(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.workspace.unsaved["/worktrees/aeolus-fleet/scout"] = []string{"?? notes.md", "commit abc1234 unpushed work"}
	pass.fleet.requests = []reconciler.Request{aRequest("releasing")}

	pass.run(t)

	if !slices.Equal(pass.workspace.removed, []string{"/worktrees/aeolus-fleet/scout"}) {
		t.Fatalf("removed %q", pass.workspace.removed)
	}
	if !slices.ContainsFunc(pass.logged, func(line string) bool {
		return strings.Contains(line, "Discarded from the worktree of scout ("+scout+"), /worktrees/aeolus-fleet/scout: ?? notes.md; commit abc1234 unpushed work")
	}) {
		t.Fatalf("logged %q", pass.logged)
	}
}

func TestAReleaseTheFleetRefusesIsTriedAgainOnTheNextPass(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.fleet.requests = []reconciler.Request{aRequest("releasing")}
	pass.fleet.refuse = "release"

	pass.run(t)
	if _, ok := pass.store.state.Entries[scout]; !ok {
		t.Fatalf("the entry went though its lease did not end")
	}
	pass.fleet.refuse = ""
	pass.run(t)

	if _, ok := pass.store.state.Entries[scout]; ok || !slices.Contains(pass.fleet.calls, "confirm "+scout) {
		t.Fatalf("entries %+v, calls %q", pass.store.state.Entries, pass.fleet.calls)
	}
}

func TestARequestNoLongerAssignedHereEndsItsSessionAndIdentityAndLeavesItsWorktree(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.fleet.requests = nil

	pass.run(t)

	if !slices.Equal(pass.sessions.stopped, []string{scout}) || len(pass.workspace.removed) != 0 || len(pass.harness.identities) != 0 || len(pass.store.state.Entries) != 0 {
		t.Fatalf("stopped %q, removed %q, identities %+v, entries %+v", pass.sessions.stopped, pass.workspace.removed, pass.harness.identities, pass.store.state.Entries)
	}
}

// givenBack crews scout, then lets its launch window pass with no activity: its request is given back.
func (p *aPass) givenBack(t *testing.T) {
	t.Helper()
	p.fleet.requests = []reconciler.Request{aRequest("")}
	p.run(t)
	p.fleet.requests = []reconciler.Request{aRequest("crewing")}
	p.pass.Now = func() time.Time { return now.Add(time.Minute) }
	p.run(t)
}

func TestARequestGivenBackRemovesItsCleanWorktree(t *testing.T) {
	pass := aRunPass(t)

	pass.givenBack(t)

	if !slices.Equal(pass.workspace.removed, []string{"/worktrees/aeolus-fleet/scout"}) || len(pass.store.state.Kept) != 0 || !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 no activity within a minute of its start") {
		t.Fatalf("removed %q, kept %+v, calls %q", pass.workspace.removed, pass.store.state.Kept, pass.fleet.calls)
	}
}

func TestARequestGivenBackKeepsAWorktreeWithChanges(t *testing.T) {
	pass := aRunPass(t)
	pass.workspace.unsaved["/worktrees/aeolus-fleet/scout"] = []string{"?? notes.md"}

	pass.givenBack(t)

	want := []any{map[string]any{"shipId": scout, "repository": "aeolus-fleet", "path": "/worktrees/aeolus-fleet/scout"}}
	if len(pass.workspace.removed) != 0 || !reflect.DeepEqual(pass.store.state.Kept, want) || len(pass.store.state.Entries) != 0 {
		t.Fatalf("removed %q, kept %+v, entries %+v", pass.workspace.removed, pass.store.state.Kept, pass.store.state.Entries)
	}
}

func TestAFailedActionIsLoggedAndTheOthersAreCarriedOut(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.refuse = "status"
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if len(pass.harness.launches) != 0 {
		t.Fatalf("launched though its crewing status was refused: %+v", pass.harness.launches)
	}
	if !slices.ContainsFunc(pass.logged, func(line string) bool { return strings.Contains(line, "the fleet refused status") }) {
		t.Fatalf("logged %q", pass.logged)
	}
}
