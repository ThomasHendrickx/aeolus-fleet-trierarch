package runpass

import (
	"errors"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/failedstarts"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/machineload"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/notices"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trash"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/workspace"
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
	// activityWrites are the activities written, one slice per call, with the interval stated; cannotWriteActivity makes the write fail.
	activityWrites      [][]fleet.ShipActivity
	activityInterval    int
	cannotWriteActivity error
	// clears are the pending clear requests; cannotReadClears makes their read fail.
	clears           []reconciler.ClearRequest
	cannotReadClears error
}

func (f *aFleet) PendingClears() ([]reconciler.ClearRequest, error) {
	if f.cannotReadClears != nil {
		return nil, f.cannotReadClears
	}
	return f.clears, nil
}
func (f *aFleet) ConfirmCleared(shipID string, repository string, outcome string) error {
	return f.call(fmt.Sprintf("confirmCleared %s %s %s", shipID, repository, outcome))
}

func (f *aFleet) ReportActivity(intervalSeconds int, activities []fleet.ShipActivity) error {
	if f.cannotWriteActivity != nil {
		return f.cannotWriteActivity
	}
	f.activityInterval = intervalSeconds
	f.activityWrites = append(f.activityWrites, activities)
	return nil
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

// someSockets are the ships' sockets, each in its ship's folder, or for a ship crewed before the ship folders under the sockets
// folder, as their identities name them; what was opened and closed, in order, and the ship's folder each was opened and closed in.
type someSockets struct {
	events []string
	opened map[string]string
	closed map[string]string
}

func (s *someSockets) Open(shipID string, shipFolder string) (string, error) {
	s.events = append(s.events, "open "+shipID)
	if s.opened == nil {
		s.opened = map[string]string{}
	}
	s.opened[shipID] = shipFolder
	if shipFolder == "" {
		return "/home/me/.aeolus/trierarch/sockets/" + shipID + "/fleet.sock", nil
	}
	return shipFolder + "/sockets/fleet.sock", nil
}
func (s *someSockets) Close(shipID string, shipFolder string) {
	s.events = append(s.events, "close "+shipID)
	if s.closed == nil {
		s.closed = map[string]string{}
	}
	s.closed[shipID] = shipFolder
}

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
	// kept is what the harness keeps for each ship beside its identity, by ship, as Claude Code keeps a ship's home in a container.
	kept     map[string]bool
	tokens   map[string]string
	launches []launched
	died     []string
	seen     map[string]reconciler.LaunchSeen
	problem  error
	// launchFails is an error every launch ends with.
	launchFails error
	// marksNoLaunches is a plugin older than the launch marker; pluginMissing one that cannot be found; notOffered why the machine does not offer the harness.
	marksNoLaunches bool
	pluginMissing   bool
	notOffered      string
	turns           map[string]string
	holding         map[string]bool
	handed          []string
	sockets         *someSockets
	// logins are the login each launch started on, in order.
	logins []string
	// activities are what each ship's session shows, by ship.
	activities map[string]activity.Activity
}

func (h *aHarness) Activity(entry reconciler.Entry) (activity.Activity, bool) {
	shown, ok := h.activities[entry.ShipID]
	return shown, ok
}

func (h *aHarness) Launch(entry reconciler.Entry, isFirstStart bool, launchID string) error {
	if h.launchFails != nil {
		return h.launchFails
	}
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
func (h *aHarness) WriteIdentity(entry reconciler.Entry, identity plugin.Identity, crewToken string) error {
	h.identities[entry.Folder], h.tokens[entry.Folder] = identity, crewToken
	h.kept[entry.ShipID] = true
	h.sockets.events = append(h.sockets.events, "identity "+identity.Socket)
	return nil
}
func (h *aHarness) Turn(entry reconciler.Entry) string {
	if turn, ok := h.turns[entry.Folder]; ok {
		return turn
	}
	return reconciler.TurnUnknown
}
func (h *aHarness) IsHolding(entry reconciler.Entry) bool { return h.holding[entry.Folder] }
func (h *aHarness) HandOver(entry reconciler.Entry) (bool, error) {
	h.handed = append(h.handed, "wake "+entry.ShipID)
	return true, nil
}
func (h *aHarness) ForceOver(entry reconciler.Entry, isTurnBusy bool) (bool, error) {
	h.handed = append(h.handed, fmt.Sprintf("force %s busy %v", entry.ShipID, isTurnBusy))
	return true, nil
}
func (h *aHarness) HasIdentity(entry reconciler.Entry) bool {
	_, ok := h.identities[entry.Folder]
	return ok
}
func (h *aHarness) DeleteIdentity(entry reconciler.Entry) error {
	delete(h.identities, entry.Folder)
	delete(h.kept, entry.ShipID)
	return nil
}
func (h *aHarness) SessionDied(entry reconciler.Entry) error {
	h.died = append(h.died, entry.Folder)
	return nil
}
func (h *aHarness) Problem() error { return h.problem }
func (h *aHarness) MarksLaunches() (bool, error) {
	if h.pluginMissing {
		return false, errors.New("the aeolus-fleet plugin's scripts are not at /plugin/scripts")
	}
	return !h.marksNoLaunches, nil
}
func (h *aHarness) NotOfferedReason() string { return h.notOffered }

// aWorkspace makes each worktree as a folder that holds what the test puts in it.
type aWorkspace struct {
	made map[string]bool
	// under are folders under the root besides the workspaces made, as a ship's folder holding its socket.
	under []string
	// gone are the ships' folders removed by hand.
	gone    map[string]bool
	unsaved map[string][]string
	removed []string
	// failRemove makes a removal fail, as a worktree that cannot be removed does.
	failRemove bool
	// failUnsaved makes reading what a worktree holds fail, as git failing does.
	failUnsaved bool
	// pruned are the repositories whose worktree records were pruned, in order.
	pruned []string
	// failPrune are the repositories whose prune fails, as when git refuses.
	failPrune map[string]bool
	// gitSteps are the prunes and branch deletions of the configured repositories, in order, as `prune <repository>` or
	// `delete branches <repository>`.
	gitSteps []string
	// failBranchDeletion are the repositories whose branches cannot be deleted, as when the remote cannot be reached.
	failBranchDeletion map[string]bool
	// prepared are the entries each Prepare was given, in order.
	prepared []reconciler.Entry
	// failRepositories are the repositories git cannot make, with git's message.
	failRepositories map[string]string
	// rootFilesWritten are the folders whose root files were written, in order.
	rootFilesWritten []string
}

func (w *aWorkspace) DeleteBranchesWhoseRemoteBranchIsGone(repository string) error {
	w.gitSteps = append(w.gitSteps, "delete branches "+repository)
	if w.failBranchDeletion[repository] {
		return errors.New("git ls-remote failed in " + repository)
	}
	return nil
}

func (w *aWorkspace) Prune(repository string) error {
	w.pruned = append(w.pruned, repository)
	w.gitSteps = append(w.gitSteps, "prune "+repository)
	if w.failPrune[repository] {
		return errors.New("git worktree prune failed in " + repository)
	}
	return nil
}

// FoldersUnderRoot are the folders made, each `/worktrees/<repository>/<name>`, whatever they are.
func (w *aWorkspace) FoldersUnderRoot() ([]string, error) {
	folders := append(slices.Collect(maps.Keys(w.made)), w.under...)
	slices.Sort(folders)
	return folders, nil
}

func (w *aWorkspace) RemoveWorktree(folder string) error {
	return w.Remove(reconciler.Entry{Folder: folder})
}

// someFolderProcesses run in the folders the test names, each by what runs, and stop them, writing down each folder stopped in while its worktree was still there.
type someFolderProcesses struct {
	workspace *aWorkspace
	running   map[string]string
	stoppedIn []string
	// failStop makes a stop fail, as processes that cannot be stopped do.
	failStop bool
}

func (f *someFolderProcesses) StopIn(folder string) (int, error) {
	if f.failStop {
		return 0, errors.New("cannot stop what runs in " + folder)
	}
	if !f.workspace.made[folder] {
		return 0, errors.New("stopped in " + folder + " after it was removed")
	}
	f.stoppedIn = append(f.stoppedIn, folder)
	if _, ok := f.running[folder]; !ok {
		return 0, nil
	}
	delete(f.running, folder)
	return 1, nil
}

// Prepare makes the folder of the ship's main repository and its name, `/worktrees/<main>/<ship>`, writing down the repository its
// main/ was made of as the entry gave it; a repository in failRepositories fails with git's message, a sub-repository saying main/ was
// made first.
func (w *aWorkspace) Prepare(entry reconciler.Entry, shipName string) (string, error) {
	w.prepared = append(w.prepared, entry)
	for _, each := range entry.Workspace.Repositories() {
		message, ok := w.failRepositories[each.Repository]
		switch {
		case ok && each.Repository == entry.Workspace.Main.Repository:
			return "", errors.New(message)
		case ok:
			return "", &workspace.MainMadeError{Repository: entry.Workspace.Main.Repository, Err: errors.New(message)}
		}
	}
	folder := "/worktrees/" + entry.Workspace.Main.Repository + "/" + shipName
	w.made[folder] = true
	return folder, nil
}

// WriteRootFiles writes down the folder whose root files were written, in order.
func (w *aWorkspace) WriteRootFiles(entry reconciler.Entry) error {
	w.rootFilesWritten = append(w.rootFilesWritten, entry.Folder)
	return nil
}

// UnsavedInShipFolder is what the folder itself holds, then each folder in it the test names, by its path.
func (w *aWorkspace) UnsavedInShipFolder(folder string) ([]workspace.Held, error) {
	if w.failUnsaved {
		return nil, errors.New("git status failed in " + folder)
	}
	held := []workspace.Held{}
	for _, path := range slices.Sorted(maps.Keys(w.unsaved)) {
		if path == folder || strings.HasPrefix(path, folder+"/") {
			held = append(held, workspace.Held{Folder: path, Unsaved: w.unsaved[path]})
		}
	}
	return held, nil
}

// ShipFolderOf is the ship's folder under the place of ships/.
func (w *aWorkspace) ShipFolderOf(shipID string) string { return "/ships/" + shipID }

// HasShipFolder is whether the ship's folder is there: every one is, but those removed by hand.
func (w *aWorkspace) HasShipFolder(folder string) bool { return !w.gone[folder] }
func (w *aWorkspace) Unsaved(folder string) ([]string, error) {
	if w.failUnsaved {
		return nil, errors.New("git status failed in " + folder)
	}
	return w.unsaved[folder], nil
}
func (w *aWorkspace) Remove(entry reconciler.Entry) error {
	if w.failRemove {
		return errors.New("cannot remove " + entry.Folder)
	}
	// A configured folder stays; its ship's folder goes.
	if entry.Workspace.Kind == "folder" {
		w.removed = append(w.removed, entry.ShipFolder)
		return nil
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
	processes *someFolderProcesses
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
		harness:   &aHarness{sessions: running, identities: map[string]plugin.Identity{}, kept: map[string]bool{}, tokens: map[string]string{}, seen: map[string]reconciler.LaunchSeen{}, turns: map[string]string{}, holding: map[string]bool{}, sockets: sockets},
		workspace: &aWorkspace{made: map[string]bool{}, unsaved: map[string][]string{}},
		store:     &aStore{state: reconciler.Empty()},
	}
	at.processes = &someFolderProcesses{workspace: at.workspace, running: map[string]string{}}
	launches := 0
	at.pass = Pass{
		Fleet:           at.fleet,
		Sessions:        at.sessions,
		Harnesses:       map[string]Harness{"claude-code": at.harness},
		Workspace:       at.workspace,
		FolderProcesses: at.processes,
		Store:           at.store,
		Log:             func(line string) { at.logged = append(at.logged, line) },
		Now:             func() time.Time { return now },
		NewLaunchID:     func() string { launches++; return fmt.Sprintf("launch-%d", launches) },
		FleetURL:        "https://fleet.example",
		Sockets:         sockets,
		Offered:         []string{"claude-code"},
		Repositories:    []string{"aeolus-fleet"},
		RunningCap:      2,
		ModelsConfirmed: map[string]int{},
		Trusted: func() map[string]reconciler.Trust {
			return map[string]reconciler.Trust{"claude-code": {Repositories: []string{"aeolus-fleet"}}}
		},
		Offers: func() map[string]map[string][]string {
			return map[string]map[string][]string{"claude-code": {"model": {"opus", "claude-sonnet-5", "claude-opus-4"}}}
		},
		RefuseModel: func(harness string, model string) error {
			at.refusedModels = append(at.refusedModels, harness+" "+model)
			return nil
		},
	}
	// The harness's settings give each option value it offers its flag, as the machine's offers do.
	at.pass.Configuration = func() map[string]config.Harness {
		configured := map[string]config.Harness{}
		for harness, offered := range at.pass.Offers() {
			options := map[string]config.Option{}
			for name, values := range offered {
				option := config.Option{Values: map[string][]string{}}
				for _, value := range values {
					option.Values[value] = []string{"--" + name, value}
				}
				options[name] = option
			}
			configured[harness] = config.Harness{Flags: []string{}, Options: options}
		}
		return configured
	}
	return at
}

func aRequest(status string) reconciler.Request {
	request := reconciler.Request{ShipID: scout, SettingsVersion: 1, Settings: reconciler.Settings{Harness: "claude-code", Workspace: reconciler.Workspace{Kind: "repositories", Main: reconciler.RepositoryAt{Repository: "aeolus-fleet"}}, FirstPrompt: "Review PR 12"}}
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
	if identity.ShipID != scout || identity.ShipName != "scout" || identity.FleetURL != "https://fleet.example" || identity.Socket != "/ships/"+scout+"/sockets/fleet.sock" || pass.harness.tokens[folder] != "aeolus_ct_v1_scout" {
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

	if !slices.Equal(pass.fleet.calls, []string{"status " + scout + " running 0 2026-11-04T12:00:00.000Z"}) {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
	if pass.store.state.Entries[scout].State != "running" {
		t.Fatalf("entry %+v", pass.store.state.Entries[scout])
	}
}

func TestARunningStatusSaysWhenTheSessionStartedInUTCWithMillisecondsWhateverTheMachinesZone(t *testing.T) {
	zone := time.FixedZone("UTC+1", 3600)
	local := time.Local
	time.Local = zone
	t.Cleanup(func() { time.Local = local })
	pass := aRunPass(t)
	pass.pass.Now = func() time.Time { return time.Date(2026, 11, 5, 13, 11, 12, 123456789, time.Local) }
	pass.fleet.requests = []reconciler.Request{aRequest("")}
	pass.run(t)
	pass.harness.seen[scout] = reconciler.LaunchSeen{Kind: reconciler.LaunchActive}
	pass.fleet.requests = []reconciler.Request{aRequest("crewing")}
	pass.fleet.calls = nil

	pass.run(t)

	if !slices.Equal(pass.fleet.calls, []string{"status " + scout + " running 0 2026-11-05T12:11:12.123Z"}) {
		t.Fatalf("calls %q", pass.fleet.calls)
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

	if !slices.ContainsFunc(pass.logged, func(line string) bool {
		return strings.Contains(line, "counting it failed: the state file is unreadable")
	}) {
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

func TestANewSettingsVersionIsCrewedAgainUnderTheLeaseItHoldsNeverReleasedAndRegisteredAgain(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	crewToken := pass.store.state.Entries[scout].CrewToken
	pass.harness.launches = nil
	again := aRequest("running")
	again.SettingsVersion = 2
	pass.fleet.requests = []reconciler.Request{again}

	pass.run(t)

	// Core removes the crew request on a release (#367), so the lease is kept.
	if slices.ContainsFunc(pass.fleet.calls, func(call string) bool {
		return strings.HasPrefix(call, "release ") || strings.HasPrefix(call, "register ") || strings.HasPrefix(call, "getStartingPrompt ")
	}) {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
	entry := pass.store.state.Entries[scout]
	if len(pass.harness.launches) != 1 || entry.SettingsVersion != 2 || entry.CrewToken != crewToken || pass.harness.tokens[scoutFolder] != crewToken {
		t.Fatalf("launches %+v, entry %+v, token %q", pass.harness.launches, entry, pass.harness.tokens[scoutFolder])
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

	want := []told{{to: "argo", key: "trierarch:refused:" + scout + ":1", text: notices.SettingsRefused(notices.Ship{ID: scout, Name: "scout"}, 1, "harness: This trierarch offers no harness codex")}}
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
	if !slices.Equal(pass.workspace.removed, []string{"/worktrees/aeolus-fleet/scout"}) || pass.harness.HasIdentity(reconciler.Entry{Folder: "/worktrees/aeolus-fleet/scout"}) {
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

func TestARequestNoLongerAssignedHereEndsItsSessionAndIdentityAndRemovesItsCleanWorktreeWithWhatRunsInIt(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.processes.running[folder] = "astro dev"
	pass.fleet.requests = nil

	pass.run(t)

	if !slices.Equal(pass.sessions.stopped, []string{scout}) || len(pass.harness.identities) != 0 || len(pass.store.state.Entries) != 0 {
		t.Fatalf("stopped %q, identities %+v, entries %+v", pass.sessions.stopped, pass.harness.identities, pass.store.state.Entries)
	}
	if !slices.Equal(pass.processes.stoppedIn, []string{folder}) || !slices.Equal(pass.workspace.removed, []string{folder}) || len(pass.store.state.Orphans) != 0 {
		t.Fatalf("stopped in %q, removed %q, orphans %+v", pass.processes.stoppedIn, pass.workspace.removed, pass.store.state.Orphans)
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

	want := []string{"open " + scout, "identity /ships/" + scout + "/sockets/fleet.sock"}
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

func TestEachPassKeepsTheProxyRunningWhileAHarnessOffersAnMCPServer(t *testing.T) {
	pass := aRunPass(t)
	proxy := &aProxy{}
	offered := map[string][]string{"claude-code": {}, "codex": {}}
	pass.pass.Proxy, pass.pass.Keys = proxy, someKeys{}
	pass.pass.McpServers = func() map[string][]string { return offered }

	pass.run(t)
	offered["claude-code"] = []string{"company-graph"}
	pass.run(t)

	if !slices.Equal(proxy.kept, []bool{false, true}) {
		t.Fatalf("kept %v, want not needed, then needed once claude-code offers company-graph", proxy.kept)
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

func TestAReleaseOfAWorktreeThatHeldNothingTellsNobody(t *testing.T) {
	pass := aRunPass(t)

	pass.released(t)

	if len(pass.fleet.told) != 0 {
		t.Fatalf("told %+v", pass.fleet.told)
	}
}

func TestAReleaseWhoseWorktreeCannotBeReadLeavesItAndTriesAgainOnTheNextPass(t *testing.T) {
	pass := aRunPass(t)
	pass.workspace.failUnsaved = true

	pass.released(t, "?? notes.md")

	if len(pass.workspace.removed) != 0 || slices.Contains(pass.fleet.calls, "confirm "+scout) {
		t.Fatalf("removed %q, calls %q", pass.workspace.removed, pass.fleet.calls)
	}
	pass.workspace.failUnsaved = false
	pass.run(t)

	if len(pass.workspace.removed) != 1 || !slices.Contains(pass.fleet.calls, "confirm "+scout) || len(pass.fleet.told) != 0 {
		t.Fatalf("removed %q, calls %q, told %+v", pass.workspace.removed, pass.fleet.calls, pass.fleet.told)
	}
}

func TestAReleaseOfAFolderCrewTellsNobodyAndRemovesItsShipsFolderAlone(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	entry := pass.store.state.Entries[scout]
	entry.Workspace = reconciler.Workspace{Kind: "folder", Name: "notes"}
	pass.store.state.Entries[scout] = entry
	pass.workspace.unsaved[entry.Folder] = []string{"?? notes.md"}
	pass.fleet.requests = []reconciler.Request{aRequest("releasing")}

	pass.run(t)

	if len(pass.fleet.told) != 0 || !slices.Equal(pass.workspace.removed, []string{"/ships/" + scout}) {
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

func TestARequestPickingAModelItsHarnessDoesNotListConfirmsTheHarnessAgainAndTakesTheModelItThenOffers(t *testing.T) {
	pass := aRunPass(t)
	offered := []string{"opus"}
	pass.pass.Offers = func() map[string]map[string][]string {
		return map[string]map[string][]string{"claude-code": {"model": offered}}
	}
	confirmed := []string{}
	pass.pass.ConfirmModels = func(harness string) {
		confirmed = append(confirmed, harness)
		offered = []string{"opus", "claude-haiku-5"}
	}
	request := aRequest("")
	request.Settings.Options = map[string]string{"model": "claude-haiku-5"}
	pass.fleet.requests = []reconciler.Request{request}

	pass.run(t)

	if !slices.Equal(confirmed, []string{"claude-code"}) {
		t.Fatalf("confirmed %v, want claude-code once", confirmed)
	}
	for _, call := range pass.fleet.calls {
		if strings.HasPrefix(call, "giveBack") {
			t.Fatalf("calls %q, want the request taken", pass.fleet.calls)
		}
	}
}

func TestARequestPickingAModelTheHarnessStillDoesNotListAfterConfirmingAgainIsGivenBack(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.Offers = func() map[string]map[string][]string {
		return map[string]map[string][]string{"claude-code": {"model": {"opus"}}}
	}
	confirmed := 0
	pass.pass.ConfirmModels = func(string) { confirmed++ }
	request := aRequest("")
	request.Settings.Options = map[string]string{"model": "claude-haiku-5"}
	pass.fleet.requests = []reconciler.Request{request}

	pass.run(t)

	if confirmed != 1 {
		t.Errorf("confirmed %d times, want once before the give-back", confirmed)
	}
	if !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: options.model: model must be one of opus") {
		t.Fatalf("calls %q, want it given back", pass.fleet.calls)
	}
}

func TestARequestPickingAModelWhileItsHarnessOffersNoModelConfirmsTheHarnessAgain(t *testing.T) {
	pass := aRunPass(t)
	offered := map[string][]string{}
	pass.pass.Offers = func() map[string]map[string][]string {
		return map[string]map[string][]string{"claude-code": offered}
	}
	confirmed := []string{}
	pass.pass.ConfirmModels = func(harness string) {
		confirmed = append(confirmed, harness)
		offered = map[string][]string{"model": {"opus", "claude-haiku-5"}}
	}
	request := aRequest("")
	request.Settings.Options = map[string]string{"model": "claude-haiku-5"}
	pass.fleet.requests = []reconciler.Request{request}

	pass.run(t)

	if !slices.Equal(confirmed, []string{"claude-code"}) {
		t.Fatalf("confirmed %v, want claude-code once", confirmed)
	}
	if got := pass.store.state.Entries[scout].Options["model"]; got != "claude-haiku-5" {
		t.Errorf("crewed with model %q, want claude-haiku-5", got)
	}
}

func TestARequestWaitingToBeCrewedConfirmsItsHarnessOnceAtItsSettingsVersion(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.RunningCap = 0
	pass.pass.Offers = func() map[string]map[string][]string {
		return map[string]map[string][]string{"claude-code": {}}
	}
	confirmed := 0
	pass.pass.ConfirmModels = func(string) { confirmed++ }
	request := aRequest("")
	request.Settings.Options = map[string]string{"model": "claude-haiku-5"}
	pass.fleet.requests = []reconciler.Request{request}

	pass.run(t)
	pass.run(t)

	if confirmed != 1 {
		t.Errorf("confirmed %d times, want once while it waits", confirmed)
	}
}

func TestEachPassAsksForTheModelsDueToBeConfirmedAgain(t *testing.T) {
	pass := aRunPass(t)
	asked := 0
	pass.pass.ConfirmDue = func() { asked++ }

	pass.run(t)
	pass.run(t)

	if asked != 2 {
		t.Errorf("asked %d times, want once per pass", asked)
	}
}

func TestARequestInARepositoryTheHarnessDoesNotTrustIsGivenBack(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.Trusted = func() map[string]reconciler.Trust { return map[string]reconciler.Trust{} }
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	want := "giveBack " + scout + " 1 mac-mini: workspace.main.repository: claude-code does not trust the repository aeolus-fleet: add it with aeolus-trierarch init, which trusts it"
	if !slices.Contains(pass.fleet.calls, want) {
		t.Fatalf("calls %q, want %q", pass.fleet.calls, want)
	}
}

func TestARequestForAHarnessTheMachineDoesNotOfferIsGivenBackWithWhy(t *testing.T) {
	pass := aRunPass(t)
	pass.harness.notOffered = "its Copilot CLI version is not detected yet"
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if want := "giveBack " + scout + " 1 mac-mini: harness: claude-code is not offered: its Copilot CLI version is not detected yet"; !slices.Contains(pass.fleet.calls, want) {
		t.Fatalf("calls %q, want %q", pass.fleet.calls, want)
	}
}

func TestARequestForAHarnessWhosePluginIsMissingIsGivenBackAndThePassGoesOn(t *testing.T) {
	pass := aRunPass(t)
	pass.harness.pluginMissing = true
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if want := "giveBack " + scout + " 1 mac-mini: harness: claude-code's aeolus-fleet plugin is not installed: run aeolus-trierarch upgrade"; !slices.Contains(pass.fleet.calls, want) {
		t.Fatalf("calls %q, want %q", pass.fleet.calls, want)
	}
}

func TestARequestForAHarnessWhosePluginMarksNoLaunchesIsGivenBack(t *testing.T) {
	pass := aRunPass(t)
	pass.harness.marksNoLaunches = true
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if want := "giveBack " + scout + " 1 mac-mini: harness: claude-code's aeolus-fleet plugin marks no launches: run aeolus-trierarch upgrade"; !slices.Contains(pass.fleet.calls, want) {
		t.Fatalf("calls %q, want %q", pass.fleet.calls, want)
	}
}

func TestThePassKeepsWhichHarnessesAreNotOfferedAndWhyForTheReport(t *testing.T) {
	pass := aRunPass(t)
	pass.harness.pluginMissing = true

	pass.run(t)

	if got := pass.store.state.MissingPlugins; !slices.Equal(got, []string{"claude-code"}) {
		t.Fatalf("missing plugins %q, want claude-code", got)
	}
}

func TestThePassKeepsWhyAnAdapterDoesNotOfferItsHarness(t *testing.T) {
	pass := aRunPass(t)
	pass.harness.notOffered = "its Copilot CLI version is not detected yet"

	pass.run(t)

	if want := []reconciler.NotOfferedHarness{{Harness: "claude-code", Reason: "its Copilot CLI version is not detected yet"}}; !slices.Equal(pass.store.state.NotOffered, want) {
		t.Fatalf("not offered %+v, want %+v", pass.store.state.NotOffered, want)
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

	// Stopped by the pass, then by its crew before its worktree goes.
	if !slices.Equal(pass.sessions.stopped, []string{scout, scout}) || !slices.Equal(pass.workspace.removed, []string{scoutFolder}) {
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

func TestAShipReleasedElsewhereWhoseSessionDoesNotStopKeepsItsWorktreeUnreadAndIsCrewedNowhere(t *testing.T) {
	pass := aRunPass(t)
	pass.releasedElsewhere(t)
	pass.workspace.unsaved[scoutFolder] = []string{"?? draft.md"}
	pass.sessions.stopFails = true

	pass.run(t)
	pass.run(t)

	if len(pass.workspace.removed) != 0 || len(pass.fleet.told) != 0 || len(pass.harness.launches) != 0 || !pass.store.state.Entries[scout].IsReleasedElsewhere {
		t.Fatalf("removed %q, told %+v, launches %+v, entry %+v", pass.workspace.removed, pass.fleet.told, pass.harness.launches, pass.store.state.Entries[scout])
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

func TestEveryPassPrunesTheWorktreeRecordsOfEachConfiguredRepository(t *testing.T) {
	p := aRunPass(t)
	p.pass.Repositories = []string{"hemma", "aeolus-fleet"}

	p.run(t)
	p.run(t)

	want := []string{"aeolus-fleet", "hemma", "aeolus-fleet", "hemma"}
	if !reflect.DeepEqual(p.workspace.pruned, want) {
		t.Errorf("pruned = %q, want %q", p.workspace.pruned, want)
	}
}

func TestAPassThatCannotReadWhatItReconcilesStillPrunesTheWorktreeRecordsOfEachConfiguredRepository(t *testing.T) {
	p := aRunPass(t)
	p.pass.Repositories = []string{"aeolus-fleet", "hemma"}
	p.fleet.cannotRead = errors.New("the fleet cannot be reached")

	p.run(t)

	want := []string{"aeolus-fleet", "hemma"}
	if !reflect.DeepEqual(p.workspace.pruned, want) {
		t.Errorf("pruned = %q, want %q", p.workspace.pruned, want)
	}
}

func TestEveryPassDeletesAfterThePruneTheLocalBranchesWhoseRemoteBranchIsGoneInEachConfiguredRepository(t *testing.T) {
	p := aRunPass(t)
	p.pass.Repositories = []string{"hemma", "aeolus-fleet"}

	p.run(t)

	want := []string{"prune aeolus-fleet", "delete branches aeolus-fleet", "prune hemma", "delete branches hemma"}
	if !reflect.DeepEqual(p.workspace.gitSteps, want) {
		t.Errorf("gitSteps = %q, want %q", p.workspace.gitSteps, want)
	}
}

func TestAPassThatCannotReadWhatItReconcilesStillDeletesTheLocalBranchesWhoseRemoteBranchIsGone(t *testing.T) {
	p := aRunPass(t)
	p.pass.Repositories = []string{"aeolus-fleet"}
	p.fleet.cannotRead = errors.New("the fleet cannot be reached")

	p.run(t)

	if !slices.Contains(p.workspace.gitSteps, "delete branches aeolus-fleet") {
		t.Errorf("gitSteps = %q, want it to hold delete branches aeolus-fleet", p.workspace.gitSteps)
	}
}

func TestARepositoryWhoseBranchesCannotBeDeletedIsLoggedAndTheOthersGoOnWithoutFailingThePass(t *testing.T) {
	p := aRunPass(t)
	p.pass.Repositories = []string{"aeolus-fleet", "hemma"}
	p.workspace.failBranchDeletion = map[string]bool{"aeolus-fleet": true}

	p.run(t)

	if !slices.Contains(p.workspace.gitSteps, "delete branches hemma") {
		t.Errorf("gitSteps = %q, want it to hold delete branches hemma", p.workspace.gitSteps)
	}
	wantLog := "Could not delete the local branches whose remote branch is gone in aeolus-fleet: git ls-remote failed in aeolus-fleet; the next pass tries again"
	if !slices.Contains(p.logged, wantLog) {
		t.Errorf("logged = %q, want it to hold %q", p.logged, wantLog)
	}
	if p.store.state.PassFailure != nil {
		t.Errorf("passFailure = %+v, want none", p.store.state.PassFailure)
	}
}

func TestARepositoryWhosePruneFailsIsLoggedAndTheOthersArePrunedWithoutFailingThePass(t *testing.T) {
	p := aRunPass(t)
	p.pass.Repositories = []string{"aeolus-fleet", "hemma"}
	p.workspace.failPrune = map[string]bool{"aeolus-fleet": true}

	p.run(t)

	if !slices.Contains(p.workspace.pruned, "hemma") {
		t.Errorf("pruned = %q, want it to hold hemma", p.workspace.pruned)
	}
	wantLog := "Could not prune the worktree records of aeolus-fleet: git worktree prune failed in aeolus-fleet; the next pass tries again"
	if !slices.Contains(p.logged, wantLog) {
		t.Errorf("logged = %q, want it to hold %q", p.logged, wantLog)
	}
	if p.store.state.PassFailure != nil {
		t.Errorf("passFailure = %+v, want none", p.store.state.PassFailure)
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

// aUsageSend writes down each released entry whose last usage was sent, with whether its folder and identity were still there; it fails while failWith is set.
type aUsageSend struct {
	pass     *aPass
	sent     []string
	wasThere []bool
	failWith error
}

func (u *aUsageSend) send(entry reconciler.Entry) error {
	if u.failWith != nil {
		return u.failWith
	}
	u.sent = append(u.sent, entry.ShipID)
	u.wasThere = append(u.wasThere, u.pass.workspace.made[entry.Folder] && u.pass.harness.HasIdentity(entry))
	return nil
}

func (p *aPass) sendingReleasedUsage() *aUsageSend {
	sending := &aUsageSend{pass: p}
	p.pass.SendReleasedUsage = sending.send
	return sending
}

func TestAReleaseSendsTheShipsLastUsageBeforeItsIdentityAndWorktreeGo(t *testing.T) {
	pass := aRunPass(t)
	sending := pass.sendingReleasedUsage()

	pass.released(t)

	if !slices.Equal(sending.sent, []string{scout}) || !slices.Equal(sending.wasThere, []bool{true}) || len(pass.workspace.removed) != 1 {
		t.Fatalf("sent %q with folder and identity there %v, removed %q", sending.sent, sending.wasThere, pass.workspace.removed)
	}
}

func TestAReleaseWhoseLastUsageTheFleetDoesNotTakeKeepsTheWorktreeAndTheRequestAndTriesAgainOnTheNextPass(t *testing.T) {
	pass := aRunPass(t)
	sending := pass.sendingReleasedUsage()
	sending.failWith = errors.New("unreachable")

	pass.released(t)

	if len(pass.workspace.removed) != 0 || slices.Contains(pass.fleet.calls, "confirm "+scout) || !pass.harness.HasIdentity(reconciler.Entry{Folder: scoutFolder}) {
		t.Fatalf("removed %q, calls %q, identities %+v", pass.workspace.removed, pass.fleet.calls, pass.harness.identities)
	}
	if _, ok := pass.store.state.Entries[scout]; !ok {
		t.Fatalf("the entry went though its usage was not sent")
	}
	sending.failWith = nil
	pass.run(t)

	if !slices.Equal(sending.sent, []string{scout}) || len(pass.workspace.removed) != 1 || !slices.Contains(pass.fleet.calls, "confirm "+scout) {
		t.Fatalf("sent %q, removed %q, calls %q", sending.sent, pass.workspace.removed, pass.fleet.calls)
	}
}

func TestAReleaseOfAFolderCrewSendsTheShipsLastUsageToo(t *testing.T) {
	pass := aRunPass(t)
	sending := pass.sendingReleasedUsage()
	pass.crewed(t)
	entry := pass.store.state.Entries[scout]
	entry.Workspace = reconciler.Workspace{Kind: "folder", Name: "notes"}
	pass.store.state.Entries[scout] = entry
	pass.fleet.requests = []reconciler.Request{aRequest("releasing")}

	pass.run(t)

	if !slices.Equal(sending.sent, []string{scout}) {
		t.Fatalf("sent %q", sending.sent)
	}
}

func TestAShipReleasedElsewhereSendsItsLastUsageBeforeItsWorktreeGoes(t *testing.T) {
	pass := aRunPass(t)
	sending := pass.sendingReleasedUsage()
	pass.releasedElsewhere(t)

	pass.run(t)

	if !slices.Equal(sending.sent, []string{scout}) || !slices.Equal(sending.wasThere, []bool{true}) || !slices.Equal(pass.workspace.removed, []string{scoutFolder}) {
		t.Fatalf("sent %q with folder and identity there %v, removed %q", sending.sent, sending.wasThere, pass.workspace.removed)
	}
}

func TestAShipReleasedElsewhereWhoseLastUsageTheFleetDoesNotTakeKeepsItsWorktreeAndIsCrewedNowhere(t *testing.T) {
	pass := aRunPass(t)
	sending := pass.sendingReleasedUsage()
	pass.releasedElsewhere(t)
	sending.failWith = errors.New("unreachable")

	pass.run(t)

	if len(pass.workspace.removed) != 0 || len(pass.harness.launches) != 0 || !pass.store.state.Entries[scout].IsReleasedElsewhere {
		t.Fatalf("removed %q, launches %+v, entry %+v", pass.workspace.removed, pass.harness.launches, pass.store.state.Entries[scout])
	}
}

func TestTheActivityOfARunningSessionIsWrittenEachPassWithTheInterval30Seconds(t *testing.T) {
	at := aRunPass(t)
	at.crewed(t)
	wrote := now.Add(-2 * time.Second)
	at.harness.activities = map[string]activity.Activity{scout: {At: wrote, Kind: "tool", Tool: "Bash"}}

	at.run(t)
	at.run(t)

	want := []fleet.ShipActivity{{ShipID: scout, Activity: activity.Activity{At: wrote, Kind: "tool", Tool: "Bash"}}}
	if len(at.fleet.activityWrites) != 2 || !reflect.DeepEqual(at.fleet.activityWrites[1], want) || at.fleet.activityInterval != 30 {
		t.Fatalf("written %+v at an interval of %d, want %+v each pass at 30", at.fleet.activityWrites, at.fleet.activityInterval, want)
	}
}

func TestNoActivityIsWrittenForASessionThatShowsNoneOrHasExited(t *testing.T) {
	at := aRunPass(t)
	at.crewed(t)
	at.harness.activities = map[string]activity.Activity{scout: {At: now, Kind: "text"}}
	at.run(t)
	at.fleet.activityWrites = nil

	at.harness.activities = map[string]activity.Activity{}
	at.run(t)
	if len(at.fleet.activityWrites) != 0 {
		t.Errorf("wrote %+v for a session that shows no activity", at.fleet.activityWrites)
	}

	at.harness.activities = map[string]activity.Activity{scout: {At: now, Kind: "text"}}
	at.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited"}}
	at.run(t)
	for _, written := range at.fleet.activityWrites {
		if len(written) != 0 {
			t.Errorf("wrote %+v for a session that exited", written)
		}
	}
}

func TestAnActivityThatCannotBeWrittenIsToldAndNeverFailsThePass(t *testing.T) {
	at := aRunPass(t)
	at.crewed(t)
	at.harness.activities = map[string]activity.Activity{scout: {At: now, Kind: "text"}}
	at.fleet.cannotWriteActivity = errors.New("the fleet is busy")
	at.logged = nil

	at.run(t)

	if !slices.Contains(at.logged, "The activity of the sessions was not written: the fleet is busy; the next pass tries again") {
		t.Errorf("logged %q", at.logged)
	}
	if at.store.state.PassFailure != nil {
		t.Errorf("pass failure %+v, want none", at.store.state.PassFailure)
	}
}

func TestARequestNoLongerAssignedHereRemovesWhatTheHarnessKeepsForTheShipEvenWhenItsIdentityIsAlreadyGone(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	delete(pass.harness.identities, folder)
	pass.fleet.requests = nil

	pass.run(t)

	if len(pass.harness.kept) != 0 {
		t.Fatalf("the harness still keeps %v", pass.harness.kept)
	}
}

const stray = "/worktrees/aeolus-fleet/stray"

// strayLine is what the pass logs of a folder under the root no crewed ship uses that it removed.
const strayLine = "Removed " + stray + ", a folder under the root no crewed ship uses"

func TestEveryFolderUnderTheRootNoCrewedShipUsesIsRemovedWhateverItHoldsWithWhatRunsInItStoppedFirst(t *testing.T) {
	pass := aRunPass(t)
	pass.workspace.made[stray] = true
	pass.workspace.unsaved[stray] = []string{" M README.md", "commit 1a2b3c4 wip"}
	pass.processes.running[stray] = "astro dev"

	pass.run(t)

	if !slices.Equal(pass.processes.stoppedIn, []string{stray}) || !slices.Equal(pass.workspace.removed, []string{stray}) || len(pass.store.state.Orphans) != 0 {
		t.Fatalf("stopped in %q, removed %q, orphans %+v", pass.processes.stoppedIn, pass.workspace.removed, pass.store.state.Orphans)
	}
	if want := strayLine + ", after stopping 1 process in it, discarding:  M README.md; commit 1a2b3c4 wip"; !slices.Contains(pass.logged, want) {
		t.Fatalf("logged %q, want %q", pass.logged, want)
	}
}

func TestAFolderUnderTheRootWithNothingRunningInItIsRemovedSayingNoProcess(t *testing.T) {
	pass := aRunPass(t)
	pass.workspace.made[stray] = true

	pass.run(t)

	if !slices.Contains(pass.logged, strayLine) {
		t.Fatalf("logged %q", pass.logged)
	}
}

func TestAFolderUnderTheRootWhoseContentCannotBeReadIsRemovedAllTheSame(t *testing.T) {
	pass := aRunPass(t)
	pass.workspace.made[stray] = true
	pass.workspace.failUnsaved = true

	pass.run(t)

	if !slices.Equal(pass.workspace.removed, []string{stray}) || !slices.Contains(pass.logged, strayLine) {
		t.Fatalf("removed %q, logged %q", pass.workspace.removed, pass.logged)
	}
}

func TestAFolderUnderTheRootThatCannotBeRemovedIsLoggedAndTriedAgainOnTheNextPass(t *testing.T) {
	pass := aRunPass(t)
	pass.workspace.made[stray] = true
	pass.workspace.failRemove = true

	pass.run(t)

	if want := "Could not remove " + stray + ", a folder under the root no crewed ship uses: cannot remove " + stray + "; " + nextAfterFailure; !slices.Contains(pass.logged, want) {
		t.Fatalf("logged %q, want %q", pass.logged, want)
	}

	pass.workspace.failRemove = false
	pass.run(t)

	if !slices.Equal(pass.workspace.removed, []string{stray}) || len(pass.store.state.Orphans) != 0 {
		t.Fatalf("removed %q, orphans %+v", pass.workspace.removed, pass.store.state.Orphans)
	}
}

func TestAFolderUnderTheRootWhoseProcessesCannotBeStoppedIsNotRemovedNorHoldsBackTheNext(t *testing.T) {
	pass := aRunPass(t)
	other := "/worktrees/aeolus-fleet/lookout"
	pass.workspace.made[stray] = true
	pass.workspace.made[other] = true
	pass.processes.failStop = true

	pass.run(t)

	if len(pass.workspace.removed) != 0 {
		t.Fatalf("removed %q", pass.workspace.removed)
	}
	tried := 0
	for _, line := range pass.logged {
		if strings.HasPrefix(line, "Could not remove ") && strings.Contains(line, ": cannot stop what runs in") {
			tried++
		}
	}
	if tried != 2 {
		t.Fatalf("tried %d folders, want 2: %q", tried, pass.logged)
	}
}

func TestTheWorktreeAnEntryWorksInIsNeverClearedNorWhatRunsInItStopped(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.processes.running[folder] = "astro dev"

	pass.run(t)

	if len(pass.processes.stoppedIn) != 0 || len(pass.workspace.removed) != 0 || len(pass.store.state.Orphans) != 0 {
		t.Fatalf("stopped in %q, removed %q, orphans %+v", pass.processes.stoppedIn, pass.workspace.removed, pass.store.state.Orphans)
	}
}

func TestTheWorktreeAnEntryIsCrewedInThisPassIsNeverClearedNorWhatRunsInItStopped(t *testing.T) {
	pass := aRunPass(t)
	pass.workspace.made[folder] = true
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if !pass.workspace.made[folder] || len(pass.processes.stoppedIn) != 0 || len(pass.workspace.removed) != 0 || len(pass.store.state.Orphans) != 0 {
		t.Fatalf("made %v, stopped in %q, removed %q, orphans %+v", pass.workspace.made[folder], pass.processes.stoppedIn, pass.workspace.removed, pass.store.state.Orphans)
	}
}

const machineConfiguration = `{"caps":{"ships":8,"running":4}}`

// failedStartsOf are the failed starts of the other ships, the last a minute ago, as the state keeps them.
func failedStartsOf(shipIDs ...string) *failedstarts.Starts {
	var starts *failedstarts.Starts
	for _, shipID := range shipIDs {
		starts, _ = failedstarts.Count(starts, failedstarts.Outcome{ShipID: shipID, Reason: "no activity within a minute of its start"}, now.Add(-time.Minute), machineConfiguration)
	}
	return starts
}

// refusedDefaultModel crews scout, whose session refuses the model its harness picked: a failed start of the machine's.
func (p *aPass) refusedDefaultModel(t *testing.T) {
	t.Helper()
	p.pass.ConfigurationFile = machineConfiguration
	p.fleet.requests = []reconciler.Request{aRequest("")}
	p.run(t)
	p.harness.seen[scout] = reconciler.LaunchSeen{Kind: reconciler.LaunchRefused, Model: "claude-opus-4"}
	p.fleet.requests = []reconciler.Request{aRequest("crewing")}
	p.run(t)
}

func TestTheThirdShipWhoseStartFailedTellsArgoOnceThatTheMachineStoppedOfferingItself(t *testing.T) {
	pass := aRunPass(t)
	pass.store.state.FailedStarts = failedStartsOf("shp_other_a", "shp_other_b")

	pass.refusedDefaultModel(t)
	pass.run(t)

	want := []told{{to: "argo", key: "trierarch:stopped-offering:2026-11-04T12:00:00.000Z", text: notices.StoppedOffering(3, "no activity within a minute of its start")}}
	if !reflect.DeepEqual(pass.fleet.told, want) {
		t.Fatalf("told %+v, want %+v", pass.fleet.told, want)
	}
	if got := pass.store.state.FailedStarts; got == nil || got.Stopped == nil || len(got.ShipIDs) != 3 {
		t.Fatalf("failed starts %+v", got)
	}
	log := "The machine stops offering itself: the starts of 3 ships failed in a row, first: no activity within a minute of its start; it offers itself again 10 minutes after its last failed start"
	if !slices.Contains(pass.logged, log) {
		t.Fatalf("logged %q", pass.logged)
	}
}

func TestAMachineThatCannotTellArgoItStoppedOfferingItselfLogsItAndGoesOn(t *testing.T) {
	pass := aRunPass(t)
	pass.store.state.FailedStarts = failedStartsOf("shp_other_a", "shp_other_b")
	pass.fleet.refuse = "tellArgo"

	pass.refusedDefaultModel(t)

	if !slices.ContainsFunc(pass.logged, func(line string) bool {
		return strings.HasPrefix(line, "Could not tell argo the machine stopped offering itself: the fleet refused tellArgo trierarch:stopped-offering:")
	}) {
		t.Fatalf("logged %q", pass.logged)
	}
	if pass.store.state.FailedStarts == nil || pass.store.state.FailedStarts.Stopped == nil {
		t.Fatalf("failed starts %+v", pass.store.state.FailedStarts)
	}
}

func TestAFailedCrewCountsAsAFailedStartOfTheMachine(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.ConfigurationFile = machineConfiguration
	pass.store.state.FailedStarts = failedStartsOf("shp_other_a", "shp_other_b")

	pass.crewFails(t, 1)

	want := []told{{to: "argo", key: "trierarch:stopped-offering:2026-11-04T12:00:00.000Z", text: notices.StoppedOffering(3, "no activity within a minute of its start")}}
	if !reflect.DeepEqual(pass.fleet.told, want) {
		t.Fatalf("told %+v, want %+v", pass.fleet.told, want)
	}
}

func TestACrewOfOneShipThatFailsOverAndOverCountsAsOneShipSoItNeverStopsTheMachine(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.ConfigurationFile = machineConfiguration

	pass.crewFails(t, 2)

	if got := pass.store.state.FailedStarts; got == nil || len(got.ShipIDs) != 1 || got.Stopped != nil || len(pass.fleet.told) != 0 {
		t.Fatalf("failed starts %+v, told %+v", got, pass.fleet.told)
	}
}

func TestAStartThatSucceedsClearsTheFailedStartsTheStateKeeps(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.ConfigurationFile = machineConfiguration
	pass.store.state.FailedStarts = failedStartsOf("shp_other_a", "shp_other_b")

	pass.crewed(t)

	if pass.store.state.FailedStarts != nil {
		t.Fatalf("failed starts %+v", pass.store.state.FailedStarts)
	}
}

const lookout = "shp_01m6jyczpnpp5c0vxh54c966lk"

const keptPath = "/worktrees/aeolus-fleet/lookout"

// aKeptWorktree is lookout's worktree of aeolus-fleet, kept because it had changes, as the state holds it, and on disk.
func (p *aPass) aKeptWorktree() {
	p.workspace.made[keptPath] = true
	p.store.state.Kept = []any{map[string]any{"shipId": lookout, "repository": "aeolus-fleet", "path": keptPath}}
}

func TestAWorktreeAnEarlierTrierarchKeptIsRemovedAsNoCrewedShipUsesItAndTheStateKeepsNone(t *testing.T) {
	pass := aRunPass(t)
	pass.aKeptWorktree()

	pass.run(t)

	if !slices.Equal(pass.workspace.removed, []string{keptPath}) || len(pass.store.state.Kept) != 0 {
		t.Fatalf("removed %q, kept %+v", pass.workspace.removed, pass.store.state.Kept)
	}
}

func TestAClearRequestIsConfirmedNotKeptAsNoWorktreeIsKeptEvenOneAnEarlierTrierarchKept(t *testing.T) {
	pass := aRunPass(t)
	pass.aKeptWorktree()
	pass.fleet.clears = []reconciler.ClearRequest{{ShipID: lookout, Repository: "aeolus-fleet"}}

	pass.run(t)

	if !slices.Contains(pass.fleet.calls, "confirmCleared "+lookout+" aeolus-fleet not-kept") {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
}

func TestAClearRequestIsConfirmedNotKeptWhenRemovingTheFolderItNamesFails(t *testing.T) {
	pass := aRunPass(t)
	pass.aKeptWorktree()
	pass.fleet.clears = []reconciler.ClearRequest{{ShipID: lookout, Repository: "aeolus-fleet"}}
	pass.workspace.failRemove = true

	pass.run(t)

	if !slices.Contains(pass.fleet.calls, "confirmCleared "+lookout+" aeolus-fleet not-kept") {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
}

func TestAClearWhoseConfirmationIsLostIsConfirmedNotKeptOnTheNextPass(t *testing.T) {
	pass := aRunPass(t)
	pass.aKeptWorktree()
	pass.fleet.clears = []reconciler.ClearRequest{{ShipID: lookout, Repository: "aeolus-fleet"}}
	pass.fleet.refuse = "confirmCleared"

	pass.run(t)

	if !slices.Equal(pass.workspace.removed, []string{keptPath}) || len(pass.store.state.Kept) != 0 {
		t.Fatalf("removed %q, kept %+v", pass.workspace.removed, pass.store.state.Kept)
	}

	pass.fleet.refuse = ""
	pass.run(t)

	if !slices.Contains(pass.fleet.calls, "confirmCleared "+lookout+" aeolus-fleet not-kept") {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
}

func TestAPassWhoseClearRequestsCannotBeReadFailsActingOnNothing(t *testing.T) {
	pass := aRunPass(t)
	pass.aKeptWorktree()
	pass.fleet.clears = []reconciler.ClearRequest{{ShipID: lookout, Repository: "aeolus-fleet"}}
	pass.fleet.cannotReadClears = errors.New("the fleet is down")

	pass.run(t)

	if len(pass.workspace.removed) != 0 || pass.store.state.PassFailure == nil || pass.store.state.PassFailure.Reason != "the fleet is down" {
		t.Fatalf("removed %q, pass failure %+v", pass.workspace.removed, pass.store.state.PassFailure)
	}
}

func TestAClearThatFailsHoldsBackNoOtherClearOfItsShip(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.clears = []reconciler.ClearRequest{{ShipID: lookout, Repository: "aeolus-fleet-core"}, {ShipID: lookout, Repository: "aeolus-fleet"}}
	pass.fleet.refuse = "confirmCleared " + lookout + " aeolus-fleet-core"

	pass.run(t)

	if !slices.Contains(pass.fleet.calls, "confirmCleared "+lookout+" aeolus-fleet not-kept") {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
}

// aTrash holds what it could not remove, as the trash answers it each pass, and marks told what argo was told of.
type aTrash struct {
	left []trash.Left
}

func (b *aTrash) Empty() []trash.Left { return slices.Clone(b.left) }
func (b *aTrash) MarkTold(path string) error {
	for i := range b.left {
		if b.left[i].Path == path {
			b.left[i].IsTold, b.left[i].IsNew = true, false
		}
	}
	return nil
}

func aLeftClone(trashedAt time.Time) trash.Left {
	return trash.Left{Path: "/worktrees/aeolus-fleet/.trash/scout.1793707200000", PathHash: "d1b5a804892b892cbac59c6f3cd3dd3dbd9e9d721526f90850ea49e8ce6de972", Folder: "/worktrees/aeolus-fleet/scout", TrashedAt: trashedAt, IsNew: true, Why: errors.New("unlinkat a/f: permission denied")}
}

func toldOfTheTrash(all []told) []told {
	found := []told{}
	for _, each := range all {
		if strings.HasPrefix(each.key, "trierarch:trash:") {
			found = append(found, each)
		}
	}
	return found
}

func TestEveryPassEmptiesTheTrashAndLogsWhatItCouldNotRemoveOnce(t *testing.T) {
	pass := aRunPass(t)
	bin := &aTrash{left: []trash.Left{aLeftClone(now)}}
	pass.pass.Trash = bin

	if err := pass.pass.Run(); err != nil {
		t.Fatal(err)
	}
	bin.left[0].IsNew = false
	if err := pass.pass.Run(); err != nil {
		t.Fatal(err)
	}

	want := "Could not remove /worktrees/aeolus-fleet/scout, in the trash at /worktrees/aeolus-fleet/.trash/scout.1793707200000: unlinkat a/f: permission denied; every pass tries again"
	if got := slices.DeleteFunc(slices.Clone(pass.logged), func(line string) bool { return !strings.Contains(line, "trash") }); !reflect.DeepEqual(got, []string{want}) {
		t.Errorf("logged %q, want %q once", got, want)
	}
	if got := toldOfTheTrash(pass.fleet.told); len(got) != 0 {
		t.Errorf("told %+v, want nobody within a day", got)
	}
}

func TestArgoIsToldOnceOfWhatTheTrashCouldNotRemoveForADay(t *testing.T) {
	pass := aRunPass(t)
	trashedAt := now.Add(-24 * time.Hour)
	bin := &aTrash{left: []trash.Left{aLeftClone(trashedAt)}}
	bin.left[0].IsNew = false
	pass.pass.Trash = bin

	for range 2 {
		if err := pass.pass.Run(); err != nil {
			t.Fatal(err)
		}
	}

	want := []told{{to: "argo", key: "trierarch:trash:d1b5a804892b892cbac59c6f3cd3dd3dbd9e9d721526f90850ea49e8ce6de972", text: notices.LeftInTrash("/worktrees/aeolus-fleet/scout", "/worktrees/aeolus-fleet/.trash/scout.1793707200000", trashedAt, "unlinkat a/f: permission denied")}}
	if got := toldOfTheTrash(pass.fleet.told); !reflect.DeepEqual(got, want) {
		t.Errorf("told %+v, want %+v", got, want)
	}
}

func TestArgoIsNotToldOfWhatTheTrashCouldNotRemoveForLessThanADay(t *testing.T) {
	pass := aRunPass(t)
	bin := &aTrash{left: []trash.Left{aLeftClone(now.Add(-24*time.Hour + time.Millisecond))}}
	pass.pass.Trash = bin

	if err := pass.pass.Run(); err != nil {
		t.Fatal(err)
	}

	if got := toldOfTheTrash(pass.fleet.told); len(got) != 0 {
		t.Errorf("told %+v, want nobody a millisecond short of a day", got)
	}
}

// endedPaths are the paths that leave a worktree no crew request on this computer names (docs/design/worktrees-end-with-their-session.md), each ending scout's crew with what its worktree holds, up to and with the pass that removes it.
var endedPaths = []struct {
	name string
	end  func(p *aPass, t *testing.T, held []string)
}{
	{"a release", func(p *aPass, t *testing.T, held []string) { p.released(t, held...) }},
	{"a release elsewhere", func(p *aPass, t *testing.T, held []string) {
		p.releasedElsewhere(t)
		p.workspace.unsaved[scoutFolder] = held
		p.run(t)
	}},
	{"a give back", func(p *aPass, t *testing.T, held []string) {
		p.workspace.unsaved[scoutFolder] = held
		p.givenBack(t)
	}},
	{"a retire or a ship moved to another trierarch", func(p *aPass, t *testing.T, held []string) {
		p.crewed(t)
		p.workspace.unsaved[scoutFolder] = held
		p.fleet.requests = nil
		p.run(t)
	}},
}

func TestEveryPathRemovesTheWorktreeWhateverItHoldsLogsWhatItHeldAndTellsArgoNothing(t *testing.T) {
	for _, path := range endedPaths {
		t.Run(path.name, func(t *testing.T) {
			pass := aRunPass(t)

			path.end(pass, t, []string{" M README.md", "commit abc1234 unpushed work"})

			if !slices.Contains(pass.workspace.removed, scoutFolder) || len(pass.store.state.Kept) != 0 || len(pass.store.state.Orphans) != 0 {
				t.Fatalf("removed %q, kept %+v, orphans %+v", pass.workspace.removed, pass.store.state.Kept, pass.store.state.Orphans)
			}
			if !slices.ContainsFunc(pass.logged, func(line string) bool {
				return strings.Contains(line, "Discarded from the worktree of scout ("+scout+"), "+scoutFolder+":  M README.md; commit abc1234 unpushed work")
			}) {
				t.Fatalf("logged %q", pass.logged)
			}
			if len(pass.fleet.told) != 0 {
				t.Fatalf("told %+v, want nothing", pass.fleet.told)
			}
		})
	}
}

func TestEveryPathStopsWhatRunsInTheFolderBeforeTheWorktreeGoes(t *testing.T) {
	for _, path := range endedPaths {
		t.Run(path.name, func(t *testing.T) {
			pass := aRunPass(t)
			pass.processes.running[scoutFolder] = "astro dev"

			path.end(pass, t, nil)

			if !slices.Contains(pass.processes.stoppedIn, scoutFolder) {
				t.Fatalf("stopped in %q, want %s", pass.processes.stoppedIn, scoutFolder)
			}
		})
	}
}

func TestEveryPathKeepsTheWorktreeWhileTheFleetRefusesTheUsageSendAndTheNextPassRemovesIt(t *testing.T) {
	for _, path := range endedPaths {
		t.Run(path.name, func(t *testing.T) {
			pass := aRunPass(t)
			sending := pass.sendingReleasedUsage()
			sending.failWith = errors.New("refused")

			path.end(pass, t, []string{"?? draft.md"})
			if len(pass.workspace.removed) != 0 {
				t.Fatalf("removed %q while the usage send was refused", pass.workspace.removed)
			}
			if slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: no activity within a minute of its start") {
				// The fleet took the request back: it is no longer assigned here.
				pass.fleet.requests = nil
			}
			sending.failWith = nil
			pass.run(t)

			if !slices.Equal(sending.sent, []string{scout}) || !slices.Contains(pass.workspace.removed, scoutFolder) {
				t.Fatalf("sent %q, removed %q", sending.sent, pass.workspace.removed)
			}
		})
	}
}

func TestACrashedShipKeepsItsWorktreeWithWhatItHolds(t *testing.T) {
	pass := aRunPass(t)
	pass.workspace.unsaved[scoutFolder] = []string{"?? draft.md"}
	pass.exitedASixthTime(t)

	pass.run(t)

	if pass.store.state.Entries[scout].State != "crashed" || len(pass.workspace.removed) != 0 {
		t.Fatalf("entry %+v, removed %q", pass.store.state.Entries[scout], pass.workspace.removed)
	}
}

func TestAShipCrewedFreshKeepsItsShipsFolderInTheStateAndOpensItsSocketThere(t *testing.T) {
	pass := aRunPass(t)
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if entry := pass.store.state.Entries[scout]; entry.ShipFolder != "/ships/"+scout {
		t.Fatalf("entry %+v", entry)
	}
	if pass.sockets.opened[scout] != "/ships/"+scout {
		t.Fatalf("opened in %q", pass.sockets.opened[scout])
	}
}

// crewedBefore runs passes until scout runs, then makes its entry one a trierarch before the ship folders crewed: no ship's folder.
func (p *aPass) crewedBefore(t *testing.T) {
	t.Helper()
	p.crewed(t)
	entry := p.store.state.Entries[scout]
	entry.ShipFolder = ""
	p.store.state.Entries[scout] = entry
	p.sockets.opened = nil
}

func TestAShipCrewedBeforeTheShipFoldersKeepsItsSocketWhereItWasAcrossAPass(t *testing.T) {
	pass := aRunPass(t)
	pass.crewedBefore(t)

	pass.run(t)

	folder, opened := pass.sockets.opened[scout]
	if !opened || folder != "" {
		t.Fatalf("opened %v in %q", opened, folder)
	}
	if entry := pass.store.state.Entries[scout]; entry.ShipFolder != "" || entry.Folder != scoutFolder {
		t.Fatalf("entry %+v", entry)
	}
}

func TestAShipCrewedBeforeTheShipFoldersIsReleasedOnItsOwnPathsAndItsSocketClosedWhereItWas(t *testing.T) {
	pass := aRunPass(t)
	pass.crewedBefore(t)
	pass.fleet.requests = []reconciler.Request{}

	pass.run(t)

	if !slices.Equal(pass.workspace.removed, []string{scoutFolder}) {
		t.Fatalf("removed %q", pass.workspace.removed)
	}
	if folder, closed := pass.sockets.closed[scout]; !closed || folder != "" {
		t.Fatalf("closed %v in %q", closed, folder)
	}
}

func TestAShipCrewedBeforeTheShipFoldersAndReleasedElsewhereIsCrewedAgainInItsShipsFolder(t *testing.T) {
	pass := aRunPass(t)
	pass.releasedElsewhere(t)
	entry := pass.store.state.Entries[scout]
	entry.ShipFolder = ""
	pass.store.state.Entries[scout] = entry

	pass.run(t)

	if entry := pass.store.state.Entries[scout]; entry.ShipFolder != "/ships/"+scout || entry.State != "crewing" {
		t.Fatalf("entry %+v", entry)
	}
	if pass.sockets.opened[scout] != "/ships/"+scout {
		t.Fatalf("opened in %q", pass.sockets.opened[scout])
	}
}

func TestAShipsFolderIsNoStrayWhileItsShipIsCrewedWithItsWorkspaceElsewhere(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.workspace.under = []string{"/ships/" + scout, "/ships/" + scout + "/sockets"}

	pass.run(t)

	if len(pass.workspace.removed) != 0 {
		t.Fatalf("removed %q", pass.workspace.removed)
	}
}

func TestAShipWhoseCrewAgainInAFreshShipsFolderIsInterruptedKeepsItsMarkAndIsCrewedAgainUnderItsLeaseNeverReleased(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	crewToken := pass.store.state.Entries[scout].CrewToken
	pass.harness.launches = nil
	pass.workspace.gone = map[string]bool{"/ships/" + scout: true}
	pass.harness.launchFails = errors.New("the harness could not start")

	_ = pass.pass.Run()

	if !pass.store.state.Entries[scout].IsShipFolderGone {
		t.Fatalf("entry %+v", pass.store.state.Entries[scout])
	}
	pass.harness.launchFails = nil
	pass.run(t)

	if slices.ContainsFunc(pass.fleet.calls, func(call string) bool {
		return strings.HasPrefix(call, "release ") || strings.HasPrefix(call, "register ")
	}) {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
	entry := pass.store.state.Entries[scout]
	if len(pass.harness.launches) != 1 || !pass.harness.launches[0].isFirstStart || entry.IsShipFolderGone || entry.CrewToken != crewToken {
		t.Fatalf("launches %+v, entry %+v", pass.harness.launches, entry)
	}
}

func TestAShipWhoseShipsFolderWasRemovedIsCrewedAgainInAFreshOneAsAFirstStartUnderItsLease(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	crewToken := pass.store.state.Entries[scout].CrewToken
	pass.harness.launches = nil
	pass.workspace.gone = map[string]bool{"/ships/" + scout: true}

	pass.run(t)

	// Core removes the crew request on a release, so its lease is kept, never released and registered again.
	if slices.ContainsFunc(pass.fleet.calls, func(call string) bool {
		return strings.HasPrefix(call, "release ") || strings.HasPrefix(call, "register ") || strings.HasPrefix(call, "getStartingPrompt ")
	}) {
		t.Fatalf("calls %q", pass.fleet.calls)
	}
	if len(pass.harness.launches) != 1 || !pass.harness.launches[0].isFirstStart || pass.harness.launches[0].firstPrompt != "This is a continuation of an existing crew request in a fresh session. Your previous conversation is unavailable. Recover the current task and progress from the fleet before acting; do not repeat completed work." {
		t.Fatalf("launches %+v", pass.harness.launches)
	}
	if pass.harness.tokens[scoutFolder] != crewToken || pass.harness.identities[scoutFolder].Socket != "/ships/"+scout+"/sockets/fleet.sock" {
		t.Fatalf("identity %+v, token %q", pass.harness.identities[scoutFolder], pass.harness.tokens[scoutFolder])
	}
	entry := pass.store.state.Entries[scout]
	if entry.IsShipFolderGone || entry.ShipFolder != "/ships/"+scout || entry.State != "crewing" || entry.CrewToken != crewToken {
		t.Fatalf("entry %+v", entry)
	}
	if len(pass.fleet.told) != 0 {
		t.Fatalf("told %+v", pass.fleet.told)
	}
}

func TestAShipFolderHasItsRootFilesWrittenBeforeItsFirstStartAndBeforeEveryStartAgain(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited"}}
	pass.run(t)
	now = now.Add(5 * time.Second)
	t.Cleanup(func() { now = now.Add(-5 * time.Second) })

	pass.run(t)

	if !slices.Equal(pass.workspace.rootFilesWritten, []string{scoutFolder, scoutFolder}) || len(pass.harness.launches) != 2 {
		t.Fatalf("root files written in %q for %d starts, want before each start", pass.workspace.rootFilesWritten, len(pass.harness.launches))
	}
}

func TestAShipFolderKeepsTheRepositoryItsMainWasMadeOfSoANewMainReplacesIt(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.Repositories = []string{"aeolus-fleet", "tools"}
	pass.pass.Trusted = func() map[string]reconciler.Trust {
		return map[string]reconciler.Trust{"claude-code": {Repositories: []string{"aeolus-fleet", "tools"}}}
	}
	pass.crewed(t)
	again := aRequest("running")
	again.SettingsVersion = 2
	again.Settings.Workspace.Main.Repository = "tools"
	pass.fleet.requests = []reconciler.Request{again}

	pass.run(t)
	pass.run(t)

	prepared := pass.workspace.prepared[len(pass.workspace.prepared)-1]
	if prepared.Workspace.Main.Repository != "tools" || prepared.MadeMain != "aeolus-fleet" {
		t.Fatalf("prepared %+v, want tools named and aeolus-fleet as what main/ was made of", prepared)
	}
	if entry := pass.store.state.Entries[scout]; entry.MadeMain != "tools" {
		t.Fatalf("entry %+v, want main/ made of tools", entry)
	}
}

func TestANewMainIsKeptAcrossASubRepositoryGitCannotMakeNeverTrashedOnTheNextTry(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.Repositories = []string{"aeolus-fleet", "tools"}
	pass.pass.Trusted = func() map[string]reconciler.Trust {
		return map[string]reconciler.Trust{"claude-code": {Repositories: []string{"aeolus-fleet", "tools"}}}
	}
	pass.crewed(t)
	pass.workspace.failRepositories = map[string]string{"aeolus-fleet": "git worktree add failed: fatal: invalid reference: HEAD"}
	again := aRequest("running")
	again.SettingsVersion = 2
	again.Settings.Workspace.Main.Repository = "tools"
	again.Settings.Workspace.SubRepositories = []reconciler.RepositoryAt{{Repository: "aeolus-fleet"}}
	pass.fleet.requests = []reconciler.Request{again}
	pass.run(t)
	pass.workspace.failRepositories = nil

	pass.run(t)

	prepared := pass.workspace.prepared[len(pass.workspace.prepared)-1]
	if prepared.MadeMain != "tools" {
		t.Fatalf("prepared %+v, want main/ known as made of tools on the next try", prepared)
	}
	if entry := pass.store.state.Entries[scout]; entry.MadeMain != "tools" {
		t.Fatalf("entry %+v, want main/ made of tools", entry)
	}
}

func TestASubRepositoryGitCannotMakeFailsTheCrewWithGitsMessageAndTheThirdFailureGivesItBack(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.Repositories = []string{"aeolus-fleet", "tools"}
	pass.pass.Trusted = func() map[string]reconciler.Trust {
		return map[string]reconciler.Trust{"claude-code": {Repositories: []string{"aeolus-fleet", "tools"}}}
	}
	pass.workspace.failRepositories = map[string]string{"tools": "git worktree add failed: fatal: invalid reference: HEAD"}
	request := aRequest("")
	request.Settings.Workspace.SubRepositories = []reconciler.RepositoryAt{{Repository: "tools"}}
	pass.fleet.requests = []reconciler.Request{request}

	for range reconciler.CrewFailureBudget {
		pass.run(t)
	}

	given := slices.ContainsFunc(pass.fleet.calls, func(call string) bool {
		return strings.HasPrefix(call, "giveBack "+scout+" 1 ") && strings.Contains(call, "git worktree add failed: fatal: invalid reference: HEAD")
	})
	if !given || len(pass.harness.launches) != 0 {
		t.Fatalf("calls %q, launches %d, want the request given back with git's message and nothing started", pass.fleet.calls, len(pass.harness.launches))
	}
}

func TestAReleaseLogsWhatEachRepositoryOfTheShipFolderHeld(t *testing.T) {
	pass := aRunPass(t)
	pass.crewed(t)
	pass.workspace.unsaved[scoutFolder+"/main"] = []string{"?? main.md"}
	pass.workspace.unsaved[scoutFolder+"/sub-repos/tools"] = []string{"?? tools.md"}
	pass.fleet.requests = []reconciler.Request{aRequest("releasing")}

	pass.run(t)

	for _, want := range []string{
		"Discarded from the worktree of scout (" + scout + "), " + scoutFolder + "/main: ?? main.md",
		"Discarded from the worktree of scout (" + scout + "), " + scoutFolder + "/sub-repos/tools: ?? tools.md",
	} {
		if !slices.Contains(pass.logged, want) {
			t.Errorf("logged %q, want %q", pass.logged, want)
		}
	}
}

// crewedInTheOldLayout runs passes until scout runs, then makes its entry one saved before the ship folder layout, as the state reads it:
// its worktree in its ship's folder, holding what it holds.
func (p *aPass) crewedInTheOldLayout(t *testing.T) string {
	t.Helper()
	p.crewed(t)
	entry := p.store.state.Entries[scout]
	worktree := entry.ShipFolder + "/worktree"
	entry.Folder, entry.IsOldLayout, entry.MadeMain = worktree, true, ""
	p.store.state.Entries[scout] = entry
	p.workspace.made[worktree] = true
	p.workspace.unsaved[worktree] = []string{"?? notes.md"}
	return worktree
}

func TestAShipSavedBeforeTheShipFolderLayoutIsCrewedAgainInAFreshShipFolderUnderItsLeaseTellingNobody(t *testing.T) {
	pass := aRunPass(t)
	worktree := pass.crewedInTheOldLayout(t)
	pass.fleet.calls = nil

	pass.run(t)

	entry := pass.store.state.Entries[scout]
	if entry.IsOldLayout || entry.ShipFolder != "/ships/"+scout || entry.Folder != scoutFolder || entry.CrewToken != "aeolus_ct_v1_scout" {
		t.Fatalf("entry %+v, want crewed in a fresh ship folder under its crew token", entry)
	}
	if last := pass.harness.launches[len(pass.harness.launches)-1]; !last.isFirstStart || last.folder != scoutFolder || last.firstPrompt != "This is a continuation of an existing crew request in a fresh session. Your previous conversation is unavailable. Recover the current task and progress from the fleet before acting; do not repeat completed work." {
		t.Fatalf("launched %+v, want a first start in the fresh ship folder", last)
	}
	if !slices.Contains(pass.workspace.removed, worktree) {
		t.Errorf("removed %q, want its old worktree", pass.workspace.removed)
	}
	if !slices.Contains(pass.logged, "Discarded from the worktree of scout ("+scout+"), "+worktree+": ?? notes.md") {
		t.Errorf("logged %q, want what its old worktree held", pass.logged)
	}
	for _, call := range pass.fleet.calls {
		if strings.HasPrefix(call, "register") || strings.HasPrefix(call, "release") || strings.HasPrefix(call, "tell") {
			t.Errorf("called %q, want the ship kept under its lease and nobody told", call)
		}
	}
}

func TestAShipSavedBeforeTheShipFolderLayoutWithANewSettingsVersionHasItsOldWorktreeRemovedWhatItHeldLogged(t *testing.T) {
	pass := aRunPass(t)
	worktree := pass.crewedInTheOldLayout(t)
	again := aRequest("running")
	again.SettingsVersion = 2
	pass.fleet.requests = []reconciler.Request{again}

	pass.run(t)

	if !slices.Contains(pass.workspace.removed, worktree) {
		t.Errorf("removed %q, want its old worktree", pass.workspace.removed)
	}
	if !slices.Contains(pass.logged, "Discarded from the worktree of scout ("+scout+"), "+worktree+": ?? notes.md") {
		t.Errorf("logged %q, want what its old worktree held", pass.logged)
	}
	if entry := pass.store.state.Entries[scout]; entry.IsOldLayout || entry.Folder != scoutFolder || entry.SettingsVersion != 2 {
		t.Errorf("entry %+v, want crewed with settings version 2 in a fresh ship folder", entry)
	}
}
