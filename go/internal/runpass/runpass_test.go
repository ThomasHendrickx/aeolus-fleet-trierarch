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
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/machineload"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/notices"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"

var now = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

// aFleet holds the requests assigned to the trierarch and its ships, and writes down every call it was made; each session's inbox, by crew token, is asked apart.
type aFleet struct {
	requests []reconciler.Request
	ships    map[string]fleet.Ship
	calls    []string
	refuse   string
	inboxes  map[string]reconciler.Inbox
	asked    []string
	// told is every notice, in order; refuseOwner is the refusal the fleet gives a report to an owner.
	told        []told
	refuseOwner *fleet.Refusal
	// refuseGiveBack is the refusal the fleet gives a give-back.
	refuseGiveBack *fleet.Refusal
	// cannotRead makes the read of the assigned requests fail.
	cannotRead error
}

// told is a notice the trierarch sent: to argo, or to a ship by its id.
type told struct {
	to   string
	text string
	key  string
}

func (f *aFleet) call(text string) error {
	f.calls = append(f.calls, text)
	if f.refuse != "" && strings.HasPrefix(text, f.refuse) {
		return errors.New("the fleet refused " + text)
	}
	return nil
}
func (f *aFleet) AssignedRequests() ([]reconciler.Request, error) {
	if f.cannotRead != nil {
		return nil, f.cannotRead
	}
	return f.requests, nil
}
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
func (f *aFleet) Name() (string, error) { return "mac-mini", nil }
func (f *aFleet) GiveBack(shipID string, settingsVersion int, reason string) (*fleet.Refusal, error) {
	f.calls = append(f.calls, fmt.Sprintf("giveBack %s %d %s", shipID, settingsVersion, reason))
	return f.refuseGiveBack, nil
}
func (f *aFleet) ReportFor(crewToken string, state string, note string) error {
	return f.call(fmt.Sprintf("report %s %s %s", crewToken, state, note))
}
func (f *aFleet) ReportToArgo(text string, idempotencyKey string) error {
	f.told = append(f.told, told{to: "argo", text: text, key: idempotencyKey})
	return f.call("tellArgo " + idempotencyKey)
}
func (f *aFleet) ReportToOwner(ownerShipID string, text string, idempotencyKey string) (*fleet.Refusal, error) {
	if f.refuseOwner != nil {
		return f.refuseOwner, nil
	}
	f.told = append(f.told, told{to: ownerShipID, text: text, key: idempotencyKey})
	return nil, f.call("tellOwner " + idempotencyKey)
}
func (f *aFleet) Inbox(crewToken string) (reconciler.Inbox, error) {
	f.asked = append(f.asked, crewToken)
	return f.inboxes[crewToken], nil
}

// someSockets are the ships' sockets, each under the root, as their identities name them; what was opened and closed, in order.
type someSockets struct {
	events []string
}

func (s *someSockets) Open(shipID string) (string, error) {
	s.events = append(s.events, "open "+shipID)
	return "/home/me/.aeolus/trierarch/sockets/" + shipID + "/fleet.sock", nil
}
func (s *someSockets) Close(shipID string) { s.events = append(s.events, "close "+shipID) }

// aSessions holds the sessions that run, as the harness's launches start them.
type aSessions struct {
	observed []sessions.Observed
	stopped  []string
	// stopFails makes every Stop fail, as a session that does not end.
	stopFails bool
}

func (s *aSessions) List() ([]sessions.Observed, error) { return s.observed, nil }
func (s *aSessions) Stop(shipID string) error {
	if s.stopFails {
		return errors.New("the session did not stop")
	}
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
	turns      map[string]string
	holding    map[string]bool
	handed     []string
	sockets    *someSockets
	// logins are the login each launch started on, in order.
	logins []string
}

func (h *aHarness) Launch(entry reconciler.Entry, isFirstStart bool, launchID string) error {
	h.launches = append(h.launches, launched{shipID: entry.ShipID, folder: entry.Folder, isFirstStart: isFirstStart, launchID: launchID, firstPrompt: entry.FirstPrompt})
	h.logins = append(h.logins, entry.Login)
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
	h.sockets.events = append(h.sockets.events, "identity "+identity.Socket)
	return nil
}
func (h *aHarness) Turn(folder string) string {
	if turn, ok := h.turns[folder]; ok {
		return turn
	}
	return reconciler.TurnUnknown
}
func (h *aHarness) IsHolding(folder string) bool { return h.holding[folder] }
func (h *aHarness) HandOver(entry reconciler.Entry) (bool, error) {
	h.handed = append(h.handed, "wake "+entry.ShipID)
	return true, nil
}
func (h *aHarness) ForceOver(entry reconciler.Entry, isTurnBusy bool) (bool, error) {
	h.handed = append(h.handed, fmt.Sprintf("force %s busy %v", entry.ShipID, isTurnBusy))
	return true, nil
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
	// failRemove makes a removal fail, as a worktree that cannot be removed does.
	failRemove bool
}

func (w *aWorkspace) Prepare(entry reconciler.Entry, shipName string) (string, error) {
	folder := "/worktrees/" + entry.Workspace.Repository + "/" + shipName
	w.made[folder] = true
	return folder, nil
}
func (w *aWorkspace) Unsaved(folder string) ([]string, error) { return w.unsaved[folder], nil }
func (w *aWorkspace) Remove(entry reconciler.Entry) error {
	if w.failRemove {
		return errors.New("cannot remove " + entry.Folder)
	}
	delete(w.made, entry.Folder)
	w.removed = append(w.removed, entry.Folder)
	return nil
}

type aStore struct {
	state reconciler.State
	saves int
	// unreadableAfter is how many loads succeed before the state file is unreadable; 0 keeps it readable.
	unreadableAfter int
	loads           int
}

func (s *aStore) Load() (reconciler.State, error) {
	s.loads++
	if s.unreadableAfter > 0 && s.loads > s.unreadableAfter {
		return reconciler.State{}, errors.New("the state file is unreadable")
	}
	return s.state, nil
}
func (s *aStore) Save(state reconciler.State) error { s.state, s.saves = state, s.saves+1; return nil }

type aPass struct {
	sockets   *someSockets
	fleet     *aFleet
	sessions  *aSessions
	harness   *aHarness
	workspace *aWorkspace
	store     *aStore
	logged    []string
	// refusedModels are the models kept refused, each as its harness and id.
	refusedModels []string
	pass          Pass
}

func aRunPass(t *testing.T) *aPass {
	t.Helper()
	running := &aSessions{}
	sockets := &someSockets{}
	at := &aPass{
		sockets:   sockets,
		fleet:     &aFleet{ships: map[string]fleet.Ship{scout: {Name: "scout", Status: "awaitingCrew"}}, inboxes: map[string]reconciler.Inbox{}},
		sessions:  running,
		harness:   &aHarness{sessions: running, identities: map[string]plugin.Identity{}, tokens: map[string]string{}, seen: map[string]reconciler.LaunchSeen{}, turns: map[string]string{}, holding: map[string]bool{}, sockets: sockets},
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
		Sockets:      sockets,
		Offered:      []string{"claude-code"},
		Repositories: []string{"aeolus-fleet"},
		RunningCap:   2,
		Offers: func() map[string]map[string][]string {
			return map[string]map[string][]string{"claude-code": {"model": {"opus", "claude-sonnet-5", "claude-opus-4"}}}
		},
		RefuseModel: func(harness string, model string) error {
			at.refusedModels = append(at.refusedModels, harness+" "+model)
			return nil
		},
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

// crewFails runs passes in which scout's crew fails at its starting prompt, count times.
func (p *aPass) crewFails(t *testing.T, count int) {
	t.Helper()
	p.fleet.refuse = "getStartingPrompt"
	p.fleet.requests = []reconciler.Request{aRequest("")}
	for range count {
		p.run(t)
	}
}

func TestACrewThatFailsIsCountedAndTriedAgainOnTheNextPass(t *testing.T) {
	pass := aRunPass(t)

	pass.crewFails(t, 1)

	if got := pass.store.state.Entries[scout].CrewFailures; got != 1 {
		t.Fatalf("crew failures = %d, want 1", got)
	}
	if slices.ContainsFunc(pass.fleet.calls, func(call string) bool { return strings.HasPrefix(call, "giveBack") }) {
		t.Fatalf("given back after one failure: %q", pass.fleet.calls)
	}
	want := "scout (" + scout + "): crew failed: the fleet refused getStartingPrompt " + scout + "; " + nextAfterFailure
	if !slices.Contains(pass.logged, want) {
		t.Fatalf("logged %q, want %q", pass.logged, want)
	}
}

func TestACrewThatFailsWhileTheStateIsUnreadableLeavesTheOtherShipsToTheSamePass(t *testing.T) {
	const other = "shp_02m6jyczpnpp5c0vxh54c966cy"
	pass := aRunPass(t)
	pass.fleet.ships[other] = fleet.Ship{Name: "other", Status: "awaitingCrew"}
	pass.fleet.refuse = "getStartingPrompt " + scout
	second := aRequest("")
	second.ShipID = other
	pass.fleet.requests = []reconciler.Request{aRequest(""), second}
	pass.store.unreadableAfter = 1

	pass.run(t)

	if !slices.ContainsFunc(pass.logged, func(line string) bool { return strings.Contains(line, "counting it failed: the state file is unreadable") }) {
		t.Fatalf("logged %q", pass.logged)
	}
	if !slices.ContainsFunc(pass.fleet.calls, func(call string) bool { return strings.Contains(call, other) }) {
		t.Fatalf("the other ship was not carried on: %q", pass.fleet.calls)
	}
}

func TestACrewThatFailsTwiceIsNotGivenBackYet(t *testing.T) {
	pass := aRunPass(t)

	pass.crewFails(t, 2)

	if got := pass.store.state.Entries[scout].CrewFailures; got != 2 {
		t.Fatalf("crew failures = %d, want 2", got)
	}
	if slices.ContainsFunc(pass.fleet.calls, func(call string) bool { return strings.HasPrefix(call, "giveBack") }) {
		t.Fatalf("given back after two failures: %q", pass.fleet.calls)
	}
}

func TestACrewThatFailsThreeTimesInARowIsGivenBackWithTheLastFailureAsTheReason(t *testing.T) {
	pass := aRunPass(t)

	pass.crewFails(t, 3)

	want := "giveBack " + scout + " 1 mac-mini: crew failed 3 times: the fleet refused getStartingPrompt " + scout
	if !slices.Contains(pass.fleet.calls, want) {
		t.Fatalf("calls %q, want %q", pass.fleet.calls, want)
	}
	if len(pass.store.state.Entries) != 0 {
		t.Fatalf("entries %+v", pass.store.state.Entries)
	}
	if !slices.Contains(pass.logged, "scout ("+scout+"): crew failed: the fleet refused getStartingPrompt "+scout+"; failed 3 times in a row, so the trierarch gives it back") {
		t.Fatalf("logged %q", pass.logged)
	}
}

func TestACrewGivenBackAfterFailingRemovesItsWorktreeAndEndsItsSession(t *testing.T) {
	pass := aRunPass(t)

	pass.crewFails(t, 3)

	if !slices.Equal(pass.workspace.removed, []string{"/worktrees/aeolus-fleet/scout"}) || !slices.Contains(pass.sessions.stopped, scout) {
		t.Fatalf("removed %q, stopped %q", pass.workspace.removed, pass.sessions.stopped)
	}
}

func TestACrewThatSucceedsAfterFailuresClearsItsCount(t *testing.T) {
	pass := aRunPass(t)
	pass.crewFails(t, 2)
	pass.fleet.refuse = ""

	pass.run(t)

	if got := pass.store.state.Entries[scout].CrewFailures; got != 0 {
		t.Fatalf("crew failures after a crew = %d, want 0", got)
	}
}

func TestACrewThatCannotStartCountsAgainstItsBudgetBeforeItRegisters(t *testing.T) {
	pass := aRunPass(t)
	pass.harness.problem = errors.New("the aeolus-fleet plugin's scripts are not at /plugin/scripts")
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)
	pass.run(t)
	pass.run(t)

	want := "giveBack " + scout + " 1 mac-mini: crew failed 3 times: the aeolus-fleet plugin's scripts are not at /plugin/scripts"
	if !slices.Contains(pass.fleet.calls, want) || slices.ContainsFunc(pass.fleet.calls, func(call string) bool { return strings.HasPrefix(call, "register") }) {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
}

func TestAGivenBackReasonIsCutToWhatTheFleetTakes(t *testing.T) {
	pass := aRunPass(t)
	pass.harness.problem = errors.New(strings.Repeat("x", 300))
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)
	pass.run(t)
	pass.run(t)

	want := "giveBack " + scout + " 1 " + ("mac-mini: crew failed 3 times: " + strings.Repeat("x", 300))[:200]
	if !slices.Contains(pass.fleet.calls, want) {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
}

func TestACrewThatFailedForOneSettingsVersionCountsAfreshForTheNext(t *testing.T) {
	pass := aRunPass(t)
	pass.crewFails(t, 2)
	next := aRequest("crewing")
	next.SettingsVersion = 2
	pass.fleet.requests = []reconciler.Request{next}

	pass.run(t)

	entry := pass.store.state.Entries[scout]
	if entry.SettingsVersion != 2 || entry.CrewFailures != 1 {
		t.Fatalf("settings version %d, crew failures %d, want 2 and 1", entry.SettingsVersion, entry.CrewFailures)
	}
	if slices.ContainsFunc(pass.fleet.calls, func(call string) bool { return strings.HasPrefix(call, "giveBack") }) {
		t.Fatalf("given back: %q", pass.fleet.calls)
	}
}

func TestAGiveBackTheFleetRefusesIsRefusedInsteadAndArgoIsToldOnce(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.refuseGiveBack = &fleet.Refusal{Code: "CONFLICT", Message: "The crew is final"}
	request := aRequest("")
	request.Settings.Harness = "codex"
	pass.fleet.requests = []reconciler.Request{request}

	pass.run(t)

	want := []told{{to: "argo", key: "trierarch:refused:" + scout + ":1", text: notices.SettingsRefused(notices.Ship{ID: scout, Name: "scout"}, 1, "harness: codex is not offered on this machine")}}
	if !reflect.DeepEqual(pass.fleet.told, want) {
		t.Fatalf("told %+v, want %+v", pass.fleet.told, want)
	}
	if pass.store.state.Refused[scout] != 1 {
		t.Fatalf("refused %+v", pass.store.state.Refused)
	}
	if !slices.Contains(pass.logged, "The fleet refused to take back the crew request of "+scout+": CONFLICT: The crew is final") {
		t.Fatalf("logged %q", pass.logged)
	}
	pass.fleet.calls, pass.fleet.told = nil, nil

	pass.run(t)

	if len(pass.fleet.calls) != 0 || len(pass.fleet.told) != 0 {
		t.Fatalf("calls %q, told %+v", pass.fleet.calls, pass.fleet.told)
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

func TestAForgottenEntryStaysUntilItsSessionStoppedSoTheNextPassTriesAgain(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.fleet.requests = nil
	pass.sessions.stopFails = true

	pass.run(t)
	if _, ok := pass.store.state.Entries[scout]; !ok {
		t.Fatalf("the entry went though its session did not stop")
	}
	pass.sessions.stopFails = false
	pass.run(t)

	if !slices.Equal(pass.sessions.stopped, []string{scout}) || len(pass.harness.identities) != 0 || len(pass.store.state.Entries) != 0 {
		t.Fatalf("stopped %q, identities %+v, entries %+v", pass.sessions.stopped, pass.harness.identities, pass.store.state.Entries)
	}
}

func TestAnEntryGivenBackStaysUntilItsSessionStoppedSoTheNextPassTriesAgain(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.requests = []reconciler.Request{aRequest("")}
	pass.run(t)
	pass.fleet.requests = []reconciler.Request{aRequest("crewing")}
	pass.pass.Now = func() time.Time { return now.Add(time.Minute) }
	pass.sessions.stopFails = true

	pass.run(t)
	if _, ok := pass.store.state.Entries[scout]; !ok || slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: no activity within a minute of its start") {
		t.Fatalf("entries %+v, calls %q", pass.store.state.Entries, pass.fleet.calls)
	}
	pass.sessions.stopFails = false
	pass.run(t)

	if len(pass.store.state.Entries) != 0 || !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: no activity within a minute of its start") {
		t.Fatalf("entries %+v, calls %q", pass.store.state.Entries, pass.fleet.calls)
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

	if !slices.Equal(pass.workspace.removed, []string{"/worktrees/aeolus-fleet/scout"}) || len(pass.store.state.Kept) != 0 || !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: no activity within a minute of its start") {
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

const folder = "/worktrees/aeolus-fleet/scout"

func TestTheShipsSocketIsOpenedBeforeItsIdentityNamesIt(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	want := []string{"open " + scout, "identity /home/me/.aeolus/trierarch/sockets/" + scout + "/fleet.sock"}
	if !slices.Equal(pass.sockets.events, want) {
		t.Fatalf("sockets %q, want %q", pass.sockets.events, want)
	}
}

func TestARunningSessionsSocketIsOpenedAgainAtEachPassAsAfterTheTrierarchRestarted(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.sockets.events = nil

	pass.run(t)

	if !slices.Equal(pass.sockets.events, []string{"open " + scout}) {
		t.Fatalf("sockets %q, want it opened", pass.sockets.events)
	}
}

func TestAnIdleSessionWithDeliveriesWaitingIsHandedAMessageItsInboxAskedWithItsCrewToken(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.harness.turns[folder] = reconciler.TurnIdle
	pass.fleet.inboxes["aeolus_ct_v1_scout"] = reconciler.Inbox{Waiting: 1}
	pass.fleet.asked = nil

	pass.run(t)

	if !slices.Equal(pass.harness.handed, []string{"wake " + scout}) || !slices.Equal(pass.fleet.asked, []string{"aeolus_ct_v1_scout"}) {
		t.Fatalf("handed %q, inbox asked with %q", pass.harness.handed, pass.fleet.asked)
	}
}

func TestAnIdleSessionWhoseStoreHoldsAMessageIsHandedIt(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.harness.turns[folder] = reconciler.TurnIdle
	pass.harness.holding[folder] = true

	pass.run(t)

	if !slices.Equal(pass.harness.handed, []string{"wake " + scout}) {
		t.Fatalf("handed %q", pass.harness.handed)
	}
}

func TestABusySessionIsHandedAForcedMessageItsTurnStopped(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.harness.turns[folder] = reconciler.TurnBusy
	pass.fleet.inboxes["aeolus_ct_v1_scout"] = reconciler.Inbox{Waiting: 1, Forced: 1}

	pass.run(t)

	if !slices.Equal(pass.harness.handed, []string{"force " + scout + " busy true"}) {
		t.Fatalf("handed %q", pass.harness.handed)
	}
}

func TestASessionThatExitedIsNotWatched(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited"}}
	pass.harness.turns[folder] = reconciler.TurnIdle
	pass.fleet.inboxes["aeolus_ct_v1_scout"] = reconciler.Inbox{Waiting: 1}
	pass.fleet.asked = nil

	pass.run(t)

	if len(pass.fleet.asked) != 0 || len(pass.harness.handed) != 0 {
		t.Fatalf("inbox asked with %q, handed %q, want neither", pass.fleet.asked, pass.harness.handed)
	}
}

func TestASessionAnotherVersionHoldsIsStartedAgainOnceIdle(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "running", IsOtherVersion: true}}
	pass.harness.turns[folder] = reconciler.TurnIdle
	pass.fleet.inboxes["aeolus_ct_v1_scout"] = reconciler.Inbox{Waiting: 1}

	pass.run(t)

	last := pass.harness.launches[len(pass.harness.launches)-1]
	if len(pass.harness.launches) != 2 || last.isFirstStart || len(pass.harness.handed) != 0 || !slices.Equal(pass.harness.died, []string{folder}) {
		t.Fatalf("launches %+v, handed %q, died %q", pass.harness.launches, pass.harness.handed, pass.harness.died)
	}
}

func TestTheSocketClosesWithTheIdentity(t *testing.T) {
	cases := []struct {
		name string
		end  func(p *aPass)
	}{
		{"forgotten", func(p *aPass) { p.fleet.requests = nil }},
		{"released", func(p *aPass) { p.fleet.requests = []reconciler.Request{aRequest("releasing")} }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pass := aRunPass(t)
			pass.crewed(t)
			c.end(pass)
			pass.sockets.events = nil

			pass.run(t)

			if !slices.Contains(pass.sockets.events, "close "+scout) {
				t.Fatalf("sockets %q, want it closed", pass.sockets.events)
			}
		})
	}
}

func TestASocketClosesWhenItsRequestIsGivenBack(t *testing.T) {
	pass := aRunPass(t)

	pass.givenBack(t)

	if !slices.Contains(pass.sockets.events, "close "+scout) {
		t.Fatalf("sockets %q, want it closed", pass.sockets.events)
	}
}

// someLogins give each ship its own login, else its harness's default, else its subscription; a start on a login with a problem cannot start, and a key not ready is said by harness.
type someLogins struct {
	defaults map[string]string
	ships    map[string]string
	problems map[string]string
	// inFolder are, by folder, why a session there cannot start on its subscription, as a key in reach (K6).
	inFolder map[string]string
	// asked are the options each start problem was asked with.
	asked    []map[string]string
	notReady map[string]bool
	// keyStates are, by harness, the state of its key and since when.
	keyStates map[string][2]string
}

func (l *someLogins) LoginOf(harness string, shipName string) string {
	if login, ok := l.ships[shipName]; ok {
		return login
	}
	if login, ok := l.defaults[harness]; ok {
		return login
	}
	return "subscription"
}
func (l *someLogins) StartProblem(harness string, login string, options map[string]string, folder string) string {
	l.asked = append(l.asked, options)
	if problem, ok := l.inFolder[folder]; ok && login == "subscription" {
		return problem
	}
	return l.problems[harness+":"+login]
}
func (l *someLogins) IsKeyReady(harness string) bool { return !l.notReady[harness] }
func (l *someLogins) KeyState(harness string) (string, string) {
	if key, ok := l.keyStates[harness]; ok {
		return key[0], key[1]
	}
	return "ready", ""
}

// aProxy keeps whether each pass needed it, and fails a keep when told.
type aProxy struct {
	kept []bool
	fail error
}

func (p *aProxy) Keep(isNeeded bool) error {
	p.kept = append(p.kept, isNeeded)
	return p.fail
}

type someKeys map[string]bool

func (k someKeys) Has(harness string) bool { return k[harness] }

const noKey = "claude-code has no API key on this computer: aeolus-trierarch login claude-code --api-key"

func onKey(pass *aPass) *someLogins {
	logins := &someLogins{defaults: map[string]string{"claude-code": "apiKey"}, problems: map[string]string{}, notReady: map[string]bool{}}
	pass.pass.Logins = logins
	return logins
}

func TestEachPassKeepsTheProxyRunningWhileAHarnessHoldsAKey(t *testing.T) {
	pass := aRunPass(t)
	proxy := &aProxy{}
	keys := someKeys{}
	pass.pass.Proxy, pass.pass.Keys = proxy, keys

	pass.run(t)
	keys["codex"] = true
	pass.run(t)

	if !slices.Equal(proxy.kept, []bool{false, true}) {
		t.Fatalf("kept %v, want not needed, then needed once codex holds a key", proxy.kept)
	}
}

func TestAProxyThatCannotBeKeptIsLoggedAndThePassGoesOn(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.Proxy, pass.pass.Keys = &aProxy{fail: errors.New("the model proxy did not answer within 10s of its start")}, someKeys{"claude-code": true}
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if len(pass.harness.launches) != 1 || !slices.Contains(pass.logged, "the model proxy: the model proxy did not answer within 10s of its start") {
		t.Fatalf("launches %d, logged %q", len(pass.harness.launches), pass.logged)
	}
}

func TestASessionStartsOnItsLoginAndKeepsItInTheState(t *testing.T) {
	pass := aRunPass(t)
	onKey(pass)

	pass.crewed(t)

	if !slices.Equal(pass.harness.logins, []string{"apiKey"}) || pass.store.state.Entries[scout].Login != "apiKey" {
		t.Fatalf("launched on %q, entry %+v, want apiKey", pass.harness.logins, pass.store.state.Entries[scout])
	}
}

func TestAShipsOwnLoginComesBeforeItsHarnesssDefault(t *testing.T) {
	pass := aRunPass(t)
	onKey(pass).ships = map[string]string{"scout": "subscription"}

	pass.crewed(t)

	if !slices.Equal(pass.harness.logins, []string{"subscription"}) {
		t.Fatalf("launched on %q, want subscription", pass.harness.logins)
	}
}

func TestWithNoLoginsEverySessionStartsOnItsSubscription(t *testing.T) {
	pass := aRunPass(t)

	pass.crewed(t)

	if !slices.Equal(pass.harness.logins, []string{"subscription"}) {
		t.Fatalf("launched on %q, want subscription", pass.harness.logins)
	}
}

func TestAStartOnAnotherLoginKeepsTheEarlierOneUntilThatStart(t *testing.T) {
	pass := aRunPass(t)
	logins := onKey(pass)
	pass.crewed(t)
	logins.defaults["claude-code"] = "subscription"
	pass.sessions.observed = nil
	pass.run(t)

	entry := pass.store.state.Entries[scout]
	want := []reconciler.EarlierLogin{{Login: "apiKey", Until: now.Format(time.RFC3339Nano)}}
	if entry.Login != "subscription" || !reflect.DeepEqual(entry.EarlierLogins, want) {
		t.Fatalf("entry login %q, earlier %+v, want subscription after %+v", entry.Login, entry.EarlierLogins, want)
	}
}

func TestAStartOnTheSameLoginKeepsNoEarlierLogin(t *testing.T) {
	pass := aRunPass(t)
	onKey(pass)
	pass.crewed(t)
	pass.sessions.observed = nil
	pass.run(t)

	if entry := pass.store.state.Entries[scout]; len(pass.harness.logins) != 2 || len(entry.EarlierLogins) != 0 {
		t.Fatalf("launched on %q, earlier %+v, want two starts and no earlier login", pass.harness.logins, entry.EarlierLogins)
	}
}

func TestACrewWhoseLoginCannotStartIsGivenBackWithTheCauseBeforeItRegisters(t *testing.T) {
	pass := aRunPass(t)
	onKey(pass).problems["claude-code:apiKey"] = noKey
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: "+noKey) || slices.ContainsFunc(pass.fleet.calls, func(call string) bool { return strings.HasPrefix(call, "register") }) || len(pass.harness.launches) != 0 {
		t.Fatalf("calls %q, launches %d", pass.fleet.calls, len(pass.harness.launches))
	}
	if len(pass.store.state.Entries) != 0 {
		t.Fatalf("entries %+v", pass.store.state.Entries)
	}
}

const keyInReach = "claude-code would reach an API key on its subscription (apiKeyHelper in /home/.claude/settings.json): remove it, or run the ship on its API key"

func TestACrewOnItsSubscriptionWithAKeyInReachInItsFolderIsGivenBackBeforeItRegistersAndItsWorktreeRemoved(t *testing.T) {
	pass := aRunPass(t)
	logins := &someLogins{inFolder: map[string]string{"/worktrees/aeolus-fleet/scout": keyInReach}}
	pass.pass.Logins = logins
	request := aRequest("")
	request.Settings.Options = map[string]string{"model": "opus"}
	pass.fleet.requests = []reconciler.Request{request}

	pass.run(t)

	if !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: "+keyInReach) || slices.ContainsFunc(pass.fleet.calls, func(call string) bool { return strings.HasPrefix(call, "register") }) || len(pass.harness.launches) != 0 {
		t.Fatalf("calls %q, launches %d, want given back before it registers", pass.fleet.calls, len(pass.harness.launches))
	}
	if !slices.Equal(pass.workspace.removed, []string{"/worktrees/aeolus-fleet/scout"}) || len(pass.store.state.Entries) != 0 {
		t.Fatalf("removed %q, entries %+v, want its worktree removed and no entry", pass.workspace.removed, pass.store.state.Entries)
	}
	if len(logins.asked) != 1 || logins.asked[0]["model"] != "opus" {
		t.Fatalf("asked with %v, want the request's options", logins.asked)
	}
}

func TestAShipWhoseSessionIsGoneWaitsWhileAKeyIsInReachInItsFolder(t *testing.T) {
	pass := aRunPass(t)
	logins := &someLogins{}
	pass.pass.Logins = logins
	pass.crewed(t)
	logins.inFolder = map[string]string{"/worktrees/aeolus-fleet/scout": keyInReach}
	pass.sessions.observed = nil

	pass.run(t)
	pass.fleet.requests = []reconciler.Request{aRequest("restarting")}
	pass.run(t)

	if len(pass.harness.launches) != 1 || pass.store.state.Entries[scout].State != "restarting" || len(pass.store.state.Entries[scout].Exits) != 0 {
		t.Fatalf("launches %d, entry %+v, want waiting restarting with no restart counted", len(pass.harness.launches), pass.store.state.Entries[scout])
	}
}

func TestAShipWhoseSessionIsGoneWaitsWhileItsKeyIsNotThereAndStartsOnceItIs(t *testing.T) {
	pass := aRunPass(t)
	logins := onKey(pass)
	pass.crewed(t)
	logins.problems["claude-code:apiKey"] = noKey
	pass.sessions.observed = nil

	pass.run(t)
	pass.fleet.requests = []reconciler.Request{aRequest("restarting")}
	pass.run(t)

	if len(pass.harness.launches) != 1 || pass.store.state.Entries[scout].State != "restarting" || len(pass.store.state.Entries[scout].Exits) != 0 {
		t.Fatalf("launches %d, entry %+v, want waiting restarting with no restart counted", len(pass.harness.launches), pass.store.state.Entries[scout])
	}
	delete(logins.problems, "claude-code:apiKey")
	pass.run(t)
	if len(pass.harness.launches) != 2 || pass.store.state.Entries[scout].State != "running" {
		t.Fatalf("launches %d, entry %+v, want started again once the key is there", len(pass.harness.launches), pass.store.state.Entries[scout])
	}
}

func TestARunningSessionOnAKeyNotReadyIsHandedNothing(t *testing.T) {
	pass := aRunPass(t)
	logins := onKey(pass)
	pass.crewed(t)
	logins.notReady["claude-code"] = true
	pass.harness.turns["/worktrees/aeolus-fleet/scout"] = reconciler.TurnIdle
	pass.fleet.inboxes["aeolus_ct_v1_scout"] = reconciler.Inbox{Waiting: 1}

	pass.run(t)
	if len(pass.harness.handed) != 0 {
		t.Fatalf("handed %q, want nothing while the key is not ready", pass.harness.handed)
	}
	logins.notReady["claude-code"] = false
	pass.run(t)
	if !slices.Equal(pass.harness.handed, []string{"wake " + scout}) {
		t.Fatalf("handed %q, want a wake once the key is ready", pass.harness.handed)
	}
}

func TestASessionOnItsSubscriptionIsHandedMessagesWhateverTheKey(t *testing.T) {
	pass := aRunPass(t)
	logins := onKey(pass)
	logins.ships = map[string]string{"scout": "subscription"}
	pass.crewed(t)
	logins.notReady["claude-code"] = true
	pass.harness.turns["/worktrees/aeolus-fleet/scout"] = reconciler.TurnIdle
	pass.fleet.inboxes["aeolus_ct_v1_scout"] = reconciler.Inbox{Waiting: 1}

	pass.run(t)

	if !slices.Equal(pass.harness.handed, []string{"wake " + scout}) {
		t.Fatalf("handed %q, want a wake", pass.harness.handed)
	}
}

// aRelease crews scout, then removes its request, with what its worktree held.
func (p *aPass) released(t *testing.T, unsaved ...string) {
	t.Helper()
	p.crewed(t)
	p.workspace.unsaved["/worktrees/aeolus-fleet/scout"] = unsaved
	p.fleet.requests = []reconciler.Request{aRequest("releasing")}
	p.run(t)
}

func TestAReleaseTellsArgoWhatItsWorktreeHeldOncePerReleaseBeforeTheWorktreeGoes(t *testing.T) {
	pass := aRunPass(t)

	pass.released(t, "?? notes.md", "commit abc1234 unpushed work")

	want := []told{{to: "argo", key: "trierarch:discarded:" + scout + ":" + now.Format(time.RFC3339Nano), text: notices.Discarded(notices.Ship{ID: scout, Name: "scout"}, "aeolus-fleet", []string{"?? notes.md", "commit abc1234 unpushed work"})}}
	if !reflect.DeepEqual(pass.fleet.told, want) {
		t.Fatalf("told %+v, want %+v", pass.fleet.told, want)
	}
	if told, removed := slices.Index(pass.fleet.calls, "tellArgo "+want[0].key), len(pass.workspace.removed); told < 0 || removed != 1 {
		t.Fatalf("calls %q, removed %q", pass.fleet.calls, pass.workspace.removed)
	}
}

func TestAReleaseOfAWorktreeThatHeldNothingTellsNobody(t *testing.T) {
	pass := aRunPass(t)

	pass.released(t)

	if len(pass.fleet.told) != 0 {
		t.Fatalf("told %+v", pass.fleet.told)
	}
}

func TestAReleaseThatCannotTellArgoLeavesTheWorktreeAndTellsAgainOnTheNextPass(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.refuse = "tellArgo"

	pass.released(t, "?? notes.md")

	if len(pass.workspace.removed) != 0 || slices.Contains(pass.fleet.calls, "confirm "+scout) {
		t.Fatalf("removed %q, calls %q", pass.workspace.removed, pass.fleet.calls)
	}
	pass.fleet.refuse = ""
	pass.run(t)

	if len(pass.workspace.removed) != 1 || !slices.Contains(pass.fleet.calls, "confirm "+scout) || len(pass.fleet.told) != 2 || pass.fleet.told[0].key != pass.fleet.told[1].key {
		t.Fatalf("removed %q, calls %q, told %+v", pass.workspace.removed, pass.fleet.calls, pass.fleet.told)
	}
}

func TestAReleaseOfAFolderCrewTellsNobodyAndRemovesNothing(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	entry := pass.store.state.Entries[scout]
	entry.Workspace = reconciler.Workspace{Kind: "folder", Name: "notes"}
	pass.store.state.Entries[scout] = entry
	pass.workspace.unsaved[entry.Folder] = []string{"?? notes.md"}
	pass.fleet.requests = []reconciler.Request{aRequest("releasing")}

	pass.run(t)

	if len(pass.fleet.told) != 0 || len(pass.workspace.removed) != 0 {
		t.Fatalf("told %+v, removed %q", pass.fleet.told, pass.workspace.removed)
	}
}

// anExitedSixthTime crews scout, whose session has exited five times in the last minutes, and exits it once more.
func (p *aPass) exitedASixthTime(t *testing.T) {
	t.Helper()
	p.crewed(t)
	entry := p.store.state.Entries[scout]
	entry.Exits = []string{now.Add(-5 * time.Minute).Format(time.RFC3339Nano), now.Add(-4 * time.Minute).Format(time.RFC3339Nano), now.Add(-3 * time.Minute).Format(time.RFC3339Nano), now.Add(-2 * time.Minute).Format(time.RFC3339Nano), now.Add(-time.Minute).Format(time.RFC3339Nano)}
	p.store.state.Entries[scout] = entry
	p.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited"}}
	p.fleet.calls = nil
}

func ownedBy(pass *aPass, owner string) {
	id := "shp_owner"
	request := aRequest("running")
	request.OwnerShipID, request.OwnerName = &id, &owner
	pass.fleet.requests = []reconciler.Request{request}
}

func TestACrashTellsArgoWhenItOwnsTheShip(t *testing.T) {
	pass := aRunPass(t)
	pass.exitedASixthTime(t)
	argo, id := "argo", "shp_argo"
	request := aRequest("running")
	request.OwnerShipID, request.OwnerName = &id, &argo
	pass.fleet.requests = []reconciler.Request{request}

	pass.run(t)

	key := "trierarch:crashed:" + scout + ":2026-11-04T12:00:00.000Z"
	want := []told{{to: "argo", key: key, text: notices.Crash(notices.Ship{ID: scout, Name: "scout"}, 6, "", true)}}
	if !reflect.DeepEqual(pass.fleet.told, want) {
		t.Fatalf("told %+v, want %+v", pass.fleet.told, want)
	}
	if !slices.Contains(pass.logged, "scout ("+scout+"): crashed, its restart budget spent; argo told") {
		t.Fatalf("logged %q", pass.logged)
	}
}

func TestACrashTellsArgoWhenTheShipHasNoOwner(t *testing.T) {
	pass := aRunPass(t)
	pass.exitedASixthTime(t)
	pass.fleet.requests = []reconciler.Request{aRequest("running")}

	pass.run(t)

	if len(pass.fleet.told) != 1 || pass.fleet.told[0].to != "argo" {
		t.Fatalf("told %+v", pass.fleet.told)
	}
}

func TestACrashTellsAPersonWhoOwnsTheShipThatArgoCanRestartIt(t *testing.T) {
	pass := aRunPass(t)
	pass.exitedASixthTime(t)
	ownedBy(pass, "thomas")

	pass.run(t)

	want := []told{{to: "shp_owner", key: "trierarch:crashed:" + scout + ":2026-11-04T12:00:00.000Z", text: notices.Crash(notices.Ship{ID: scout, Name: "scout"}, 6, "", false)}}
	if !reflect.DeepEqual(pass.fleet.told, want) {
		t.Fatalf("told %+v, want %+v", pass.fleet.told, want)
	}
}

func TestACrashTheFleetRefusesToTheOwnerIsToldToArgoWithWhyAndLogged(t *testing.T) {
	pass := aRunPass(t)
	pass.exitedASixthTime(t)
	ownedBy(pass, "thomas")
	pass.fleet.refuseOwner = &fleet.Refusal{Code: "FORBIDDEN", Message: "The network rules do not allow this send"}

	pass.run(t)

	report := notices.Crash(notices.Ship{ID: scout, Name: "scout"}, 6, "", true)
	want := []told{{to: "argo", key: "trierarch:crashed:" + scout + ":2026-11-04T12:00:00.000Z:owner-unreachable", text: notices.OwnerUnreachable(report, "thomas", "FORBIDDEN", "The network rules do not allow this send")}}
	if !reflect.DeepEqual(pass.fleet.told, want) {
		t.Fatalf("told %+v, want %+v", pass.fleet.told, want)
	}
	if !slices.Contains(pass.logged, "Could not reach thomas (shp_owner), the owner of scout ("+scout+"): FORBIDDEN: The network rules do not allow this send; argo is told instead") {
		t.Fatalf("logged %q", pass.logged)
	}
}

func TestACrashThatCannotBeToldDoesNotHoldBackTheStatusItWrites(t *testing.T) {
	pass := aRunPass(t)
	pass.exitedASixthTime(t)
	pass.fleet.requests = []reconciler.Request{aRequest("running")}
	pass.fleet.refuse = "tellArgo"

	pass.run(t)

	if !slices.Contains(pass.fleet.calls, "status "+scout+" crashed 5 ") {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
	if !slices.ContainsFunc(pass.logged, func(line string) bool { return strings.HasPrefix(line, "crashed of "+scout+" failed") }) {
		t.Fatalf("logged %q", pass.logged)
	}
}

func TestAShipWhoseFolderLostItsIdentityTellsArgoOnce(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	delete(pass.harness.identities, "/worktrees/aeolus-fleet/scout")

	pass.run(t)
	pass.run(t)

	want := []told{{to: "argo", key: "trierarch:identity-gone:" + scout + ":2026-11-04T12:00:00.000Z", text: notices.IdentityGone(notices.Ship{ID: scout, Name: "scout"})}}
	if !reflect.DeepEqual(pass.fleet.told, want) {
		t.Fatalf("told %+v, want %+v", pass.fleet.told, want)
	}
	if !pass.store.state.Entries[scout].IsIdentityGone {
		t.Fatalf("entry %+v", pass.store.state.Entries[scout])
	}
}

func TestAShipWhoseSessionExitedAndWhoseFolderLostItsIdentityIsToldToo(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	delete(pass.harness.identities, "/worktrees/aeolus-fleet/scout")
	pass.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited"}}

	pass.run(t)

	if len(pass.fleet.told) != 1 || pass.fleet.told[0].text != notices.IdentityGone(notices.Ship{ID: scout, Name: "scout"}) {
		t.Fatalf("told %+v", pass.fleet.told)
	}
}

// refusedModel crews scout with the model picked, whose session refuses it.
func (p *aPass) refusedModel(t *testing.T, version string) {
	t.Helper()
	request := aRequest("")
	request.Settings.Options = map[string]string{"model": "claude-sonnet-5"}
	p.fleet.requests = []reconciler.Request{request}
	p.pass.VersionOf = func(harness string) string { return map[string]string{"claude-code": version}[harness] }
	p.run(t)
	p.harness.seen[scout] = reconciler.LaunchSeen{Kind: reconciler.LaunchRefused, Model: "claude-opus-4"}
	request.Status = status("crewing")
	p.fleet.requests = []reconciler.Request{request}
	p.run(t)
}

func status(text string) *string { return &text }

func TestAModelRefusedTellsArgoWhichModelTheSettingsPickedAtWhichVersionThenGivesTheRequestBack(t *testing.T) {
	pass := aRunPass(t)

	pass.refusedModel(t, "2.1.306")

	want := []told{{to: "argo", key: "trierarch:refused-model:claude-code:2.1.306:claude-sonnet-5", text: notices.ModelRefused(notices.Ship{ID: scout, Name: "scout"}, "claude-code", "2.1.306", "claude-sonnet-5")}}
	if !reflect.DeepEqual(pass.fleet.told, want) {
		t.Fatalf("told %+v, want %+v", pass.fleet.told, want)
	}
	if !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: claude-code 2.1.306 refused claude-sonnet-5") {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
}

func TestAModelTheSettingsPickedThatASessionRefusedIsKeptRefusedForItsHarness(t *testing.T) {
	pass := aRunPass(t)

	pass.refusedModel(t, "2.1.306")

	if want := []string{"claude-code claude-sonnet-5"}; !slices.Equal(pass.refusedModels, want) {
		t.Fatalf("refused %v, want %v", pass.refusedModels, want)
	}
}

func TestARequestPickingAModelItsHarnessOffersNoMoreIsGivenBack(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.Offers = func() map[string]map[string][]string {
		return map[string]map[string][]string{"claude-code": {"model": {"opus"}}}
	}
	request := aRequest("")
	request.Settings.Options = map[string]string{"model": "claude-sonnet-5"}
	pass.fleet.requests = []reconciler.Request{request}

	pass.run(t)

	if !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: options.model: model must be one of opus") {
		t.Fatalf("calls %q, want it given back", pass.fleet.calls)
	}
}

func TestAModelRefusedAtAVersionTheHarnessDoesNotSayTellsArgoNothing(t *testing.T) {
	pass := aRunPass(t)

	pass.refusedModel(t, "")

	if len(pass.fleet.told) != 0 || !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: claude-code refused claude-sonnet-5") {
		t.Fatalf("told %+v, calls %q", pass.fleet.told, pass.fleet.calls)
	}
}

func TestAModelRefusedThatCannotBeToldDoesNotHoldBackTheGiveBack(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.refuse = "tellArgo"

	pass.refusedModel(t, "2.1.306")

	if !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: claude-code 2.1.306 refused claude-sonnet-5") {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
}

func TestAKeyThatIsNotReadyTellsArgoOncePerStateWithTheShipsThatWait(t *testing.T) {
	pass := aRunPass(t)
	onKey(pass).keyStates = map[string][2]string{}
	pass.crewed(t)
	pass.pass.Logins.(*someLogins).keyStates["claude-code"] = [2]string{"refused", "2026-11-04T10:00:00.000Z"}

	pass.run(t)
	pass.run(t)

	want := []told{{to: "argo", key: "trierarch:key:claude-code:refused:2026-11-04T10:00:00.000Z", text: notices.KeyNotReady("claude-code", "refused", "2026-11-04T10:00:00.000Z", []notices.Ship{{ID: scout, Name: "scout"}})}}
	if !reflect.DeepEqual(pass.fleet.told, want) {
		t.Fatalf("told %+v, want %+v", pass.fleet.told, want)
	}
	if !reflect.DeepEqual(pass.store.state.KeysTold, map[string]string{"claude-code": "refused"}) {
		t.Fatalf("keys told %+v", pass.store.state.KeysTold)
	}
}

func TestAKeyThatIsReadyAgainIsForgottenSoALaterStateIsToldAgain(t *testing.T) {
	pass := aRunPass(t)
	logins := onKey(pass)
	logins.keyStates = map[string][2]string{}
	pass.crewed(t)
	logins.keyStates["claude-code"] = [2]string{"outOfCredit", "2026-11-04T10:00:00.000Z"}
	pass.run(t)
	delete(logins.keyStates, "claude-code")
	pass.run(t)
	if len(pass.store.state.KeysTold) != 0 {
		t.Fatalf("keys told %+v", pass.store.state.KeysTold)
	}
	logins.keyStates["claude-code"] = [2]string{"outOfCredit", "2026-11-04T11:00:00.000Z"}

	pass.run(t)

	if len(pass.fleet.told) != 2 || !strings.HasPrefix(pass.fleet.told[1].text, "Claude Code's API key is out of credit\n") {
		t.Fatalf("told %+v", pass.fleet.told)
	}
}

func TestAKeyArgoCouldNotBeToldOfIsTriedAgainOnTheNextPass(t *testing.T) {
	pass := aRunPass(t)
	logins := onKey(pass)
	logins.keyStates = map[string][2]string{}
	pass.crewed(t)
	logins.keyStates["claude-code"] = [2]string{"none", ""}
	pass.fleet.refuse = "tellArgo"

	pass.run(t)
	if len(pass.store.state.KeysTold) != 0 || !slices.ContainsFunc(pass.logged, func(line string) bool {
		return strings.HasPrefix(line, "Could not tell argo that claude-code's API key is not ready")
	}) {
		t.Fatalf("keys told %+v, logged %q", pass.store.state.KeysTold, pass.logged)
	}
	pass.fleet.refuse = ""
	pass.run(t)

	if !reflect.DeepEqual(pass.store.state.KeysTold, map[string]string{"claude-code": "none"}) || len(pass.fleet.told) != 2 {
		t.Fatalf("keys told %+v, told %+v", pass.store.state.KeysTold, pass.fleet.told)
	}
}

func TestAKeyNoShipHereIsOnIsNobodysConcern(t *testing.T) {
	pass := aRunPass(t)
	logins := onKey(pass)
	logins.ships = map[string]string{"scout": "subscription"}
	pass.crewed(t)
	logins.keyStates = map[string][2]string{"claude-code": {"refused", "2026-11-04T10:00:00.000Z"}}

	pass.run(t)

	if len(pass.fleet.told) != 0 {
		t.Fatalf("told %+v", pass.fleet.told)
	}
}

const scoutFolder = "/worktrees/aeolus-fleet/scout"

// releasedElsewhere is scout running, its lease ended under it and the ship crewed again by none: its next pass sees it.
func (p *aPass) releasedElsewhere(t *testing.T) {
	t.Helper()
	p.crewed(t)
	p.fleet.inboxes[p.store.state.Entries[scout].CrewToken] = reconciler.Inbox{IsLeaseEnded: true}
	p.fleet.ships[scout] = fleet.Ship{Name: "scout", Status: "awaitingCrew"}
	p.harness.launches = nil
}

func TestAShipReleasedElsewhereHasItsSessionStoppedAndIsCrewedAgainInAFreshWorktreeAsAFirstStart(t *testing.T) {
	pass := aRunPass(t)
	pass.releasedElsewhere(t)

	pass.run(t)

	if !slices.Equal(pass.sessions.stopped, []string{scout}) || !slices.Equal(pass.workspace.removed, []string{scoutFolder}) {
		t.Fatalf("stopped %q, removed %q", pass.sessions.stopped, pass.workspace.removed)
	}
	if len(pass.harness.launches) != 1 || !pass.harness.launches[0].isFirstStart || pass.harness.launches[0].firstPrompt != "Review PR 12" || pass.harness.launches[0].folder != scoutFolder {
		t.Fatalf("launches %+v", pass.harness.launches)
	}
	entry := pass.store.state.Entries[scout]
	if entry.IsReleasedElsewhere || entry.State != "crewing" || entry.CrewToken == "" {
		t.Fatalf("entry %+v", entry)
	}
	if !slices.ContainsFunc(pass.logged, func(line string) bool {
		return strings.Contains(line, "scout ("+scout+"): released elsewhere, its worktree removed")
	}) {
		t.Fatalf("logged %q", pass.logged)
	}
}

func TestAShipReleasedElsewhereTellsArgoWhatItsRemovedWorktreeHeldOnce(t *testing.T) {
	pass := aRunPass(t)
	pass.releasedElsewhere(t)
	pass.workspace.unsaved[scoutFolder] = []string{" M README.md", "?? draft.md"}

	pass.run(t)

	want := []told{{to: "argo", key: "trierarch:discarded:" + scout + ":" + now.Format(time.RFC3339Nano), text: notices.DiscardedElsewhere(notices.Ship{ID: scout, Name: "scout"}, "aeolus-fleet", []string{" M README.md", "?? draft.md"})}}
	if !slices.Equal(pass.fleet.told, want) {
		t.Fatalf("told %+v", pass.fleet.told)
	}
}

func TestAShipReleasedElsewhereWhoseWorktreeHeldNothingTellsArgoNothing(t *testing.T) {
	pass := aRunPass(t)
	pass.releasedElsewhere(t)

	pass.run(t)

	if len(pass.fleet.told) != 0 {
		t.Fatalf("told %+v", pass.fleet.told)
	}
}

func TestAShipReleasedElsewhereWhoseWorktreeCannotBeRemovedIsCrewedNowhereAndTheNextPassTriesAgain(t *testing.T) {
	pass := aRunPass(t)
	pass.releasedElsewhere(t)
	pass.workspace.unsaved[scoutFolder] = []string{"?? draft.md"}
	pass.workspace.failRemove = true

	pass.run(t)

	if len(pass.harness.launches) != 0 || !pass.store.state.Entries[scout].IsReleasedElsewhere {
		t.Fatalf("launches %+v, entry %+v", pass.harness.launches, pass.store.state.Entries[scout])
	}
	pass.workspace.failRemove = false
	pass.run(t)

	if len(pass.harness.launches) != 1 || !pass.harness.launches[0].isFirstStart || pass.store.state.Entries[scout].IsReleasedElsewhere {
		t.Fatalf("launches %+v, entry %+v", pass.harness.launches, pass.store.state.Entries[scout])
	}
}

func TestAShipReleasedElsewhereAndCrewedByAnotherSessionIsLeft(t *testing.T) {
	pass := aRunPass(t)
	pass.releasedElsewhere(t)
	pass.fleet.ships[scout] = fleet.Ship{Name: "scout", Status: "crewed"}

	pass.run(t)

	if len(pass.store.state.Entries) != 0 || len(pass.harness.launches) != 0 {
		t.Fatalf("entries %+v, launches %+v", pass.store.state.Entries, pass.harness.launches)
	}
}

func TestAPassThatCannotReadWhatItReconcilesKeepsItsReasonAndSinceWhenInTheState(t *testing.T) {
	p := aRunPass(t)
	p.fleet.cannotRead = errors.New("the fleet cannot be reached")

	p.run(t)

	want := &reconciler.PassFailure{Reason: "the fleet cannot be reached", Since: "2026-11-04T12:00:00.000Z"}
	if !reflect.DeepEqual(p.store.state.PassFailure, want) {
		t.Errorf("passFailure after a failed pass = %+v, want %+v", p.store.state.PassFailure, want)
	}
	wantLog := "The pass failed: the fleet cannot be reached; the next pass tries again; aeolus-trierarch status and list show where it stands"
	if !slices.Contains(p.logged, wantLog) {
		t.Errorf("logged = %q, want it to hold %q", p.logged, wantLog)
	}
}

func TestAFailingPassKeepsSinceWhenTheNextPassFailsWithAnotherReason(t *testing.T) {
	p := aRunPass(t)
	p.fleet.cannotRead = errors.New("the fleet cannot be reached")
	p.run(t)
	now = now.Add(5 * time.Second)
	t.Cleanup(func() { now = now.Add(-5 * time.Second) })
	p.fleet.cannotRead = errors.New("the fleet refused")

	p.run(t)

	want := &reconciler.PassFailure{Reason: "the fleet refused", Since: "2026-11-04T12:00:00.000Z"}
	if !reflect.DeepEqual(p.store.state.PassFailure, want) {
		t.Errorf("passFailure after a second failed pass = %+v, want %+v", p.store.state.PassFailure, want)
	}
}

func TestAPassThatSucceedsClearsTheFailureOfTheOnesBefore(t *testing.T) {
	p := aRunPass(t)
	p.fleet.cannotRead = errors.New("the fleet cannot be reached")
	p.run(t)
	p.fleet.cannotRead = nil

	p.run(t)

	if p.store.state.PassFailure != nil {
		t.Errorf("passFailure after a pass that succeeded = %+v, want none", p.store.state.PassFailure)
	}
}

// aMachine is a machine whose load a test sets; it is read each time the pass asks.
type aMachine struct {
	load  machineload.Load
	reads int
}

func (m *aMachine) Read() (machineload.Load, error) { m.reads++; return m.load, nil }

func aLoad(memoryAvailablePercent int64, diskFreePercent int64) machineload.Load {
	return machineload.Load{
		Memory: machineload.Memory{TotalBytes: 16 << 30, AvailableBytes: 16 << 30 * memoryAvailablePercent / 100},
		CPU:    machineload.CPU{Cores: 4},
		Disk:   machineload.Disk{TotalBytes: 500_000_000_000, FreeBytes: 500_000_000_000 * diskFreePercent / 100},
	}
}

// onAMachine has the pass read the machine each time a minute has passed.
func (p *aPass) onAMachine(machine *aMachine) {
	p.pass.Load = &machineload.Reader{Source: machine, Now: func() time.Time { return now }, Log: p.pass.Log}
}

func TestAMachineLowOnMemoryTellsArgoOnceAndTheStateKeepsIt(t *testing.T) {
	pass := aRunPass(t)
	machine := &aMachine{load: aLoad(9, 50)}
	pass.onAMachine(machine)
	pass.run(t)
	pass.run(t)
	if len(pass.fleet.told) != 1 {
		t.Fatalf("told %+v", pass.fleet.told)
	}
	got := pass.fleet.told[0]
	if got.to != "argo" || got.key != "low-memory-2026-11-04T12:00:00.000Z" || got.text != notices.LowResource("memory", machine.load) {
		t.Fatalf("told %+v", got)
	}
	if !reflect.DeepEqual(pass.store.state.LowResources, []string{"memory"}) {
		t.Fatalf("low resources %v", pass.store.state.LowResources)
	}
}

func TestAMachineLowOnBothTellsMemoryThenDisk(t *testing.T) {
	pass := aRunPass(t)
	pass.onAMachine(&aMachine{load: aLoad(9, 4)})
	pass.run(t)
	keys := []string{}
	for _, each := range pass.fleet.told {
		keys = append(keys, each.key)
	}
	if !reflect.DeepEqual(keys, []string{"low-memory-2026-11-04T12:00:00.000Z", "low-disk-2026-11-04T12:00:00.000Z"}) {
		t.Fatalf("told %q", keys)
	}
}

func TestAMachineThatStaysLowAcrossARestartTellsNothingAgain(t *testing.T) {
	pass := aRunPass(t)
	pass.store.state.LowResources = []string{"memory"}
	pass.onAMachine(&aMachine{load: aLoad(9, 50)})
	pass.run(t)
	if len(pass.fleet.told) != 0 || !reflect.DeepEqual(pass.store.state.LowResources, []string{"memory"}) {
		t.Fatalf("told %+v, low resources %v", pass.fleet.told, pass.store.state.LowResources)
	}
}

func TestAMachineThatRecoveredAndDroppedAgainTellsAgain(t *testing.T) {
	pass := aRunPass(t)
	machine := &aMachine{load: aLoad(9, 50)}
	pass.onAMachine(machine)
	pass.run(t)
	machine.load = aLoad(40, 50)
	later := now.Add(time.Minute)
	pass.pass.Now = func() time.Time { return later }
	pass.pass.Load = &machineload.Reader{Source: machine, Now: pass.pass.Now, Log: pass.pass.Log}
	pass.run(t)
	if len(pass.fleet.told) != 1 || len(pass.store.state.LowResources) != 0 {
		t.Fatalf("told %+v, low resources %v", pass.fleet.told, pass.store.state.LowResources)
	}
	machine.load = aLoad(8, 50)
	again := later.Add(time.Minute)
	pass.pass.Now = func() time.Time { return again }
	pass.pass.Load = &machineload.Reader{Source: machine, Now: pass.pass.Now, Log: pass.pass.Log}
	pass.run(t)
	if len(pass.fleet.told) != 2 || pass.fleet.told[1].key != "low-memory-2026-11-04T12:02:00.000Z" {
		t.Fatalf("told %+v", pass.fleet.told)
	}
}

func TestAMachineLowOnOneThatRecoversOfAnotherStaysToldOfTheOther(t *testing.T) {
	pass := aRunPass(t)
	pass.store.state.LowResources = []string{"memory", "disk"}
	pass.onAMachine(&aMachine{load: aLoad(40, 4)})
	pass.run(t)
	if len(pass.fleet.told) != 0 || !reflect.DeepEqual(pass.store.state.LowResources, []string{"disk"}) {
		t.Fatalf("told %+v, low resources %v", pass.fleet.told, pass.store.state.LowResources)
	}
}

func TestAFleetThatRefusesTheNoticeIsLoggedAndTheNoticeIsTriedAtTheNextRead(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.refuse = "tellArgo low-memory"
	machine := &aMachine{load: aLoad(9, 50)}
	pass.onAMachine(machine)
	pass.run(t)
	if len(pass.store.state.LowResources) != 0 || !slices.Contains(pass.logged, "Could not tell argo the machine is low: the fleet refused tellArgo low-memory-2026-11-04T12:00:00.000Z") {
		t.Fatalf("low resources %v, logged %q", pass.store.state.LowResources, pass.logged)
	}
	pass.fleet.refuse = ""
	later := now.Add(time.Minute)
	pass.pass.Now = func() time.Time { return later }
	pass.pass.Load = &machineload.Reader{Source: machine, Now: pass.pass.Now, Log: pass.pass.Log}
	pass.run(t)
	if !reflect.DeepEqual(pass.store.state.LowResources, []string{"memory"}) || len(pass.fleet.told) != 2 || pass.fleet.told[1].key != "low-memory-2026-11-04T12:01:00.000Z" {
		t.Fatalf("told %+v, low resources %v", pass.fleet.told, pass.store.state.LowResources)
	}
}

func TestAPassWithNoMachineReadsNoLoadAndTellsNothing(t *testing.T) {
	pass := aRunPass(t)
	pass.run(t)
	if len(pass.fleet.told) != 0 || pass.store.state.LowResources != nil {
		t.Fatalf("told %+v", pass.fleet.told)
	}
}
