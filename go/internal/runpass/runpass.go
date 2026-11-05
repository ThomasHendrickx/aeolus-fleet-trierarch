// Package runpass is one pass of the run loop: it reads the crew requests
// assigned to the trierarch, its saved state and what runs, asks the
// reconciler what to do, and carries the actions out, saving the state as it
// goes. A failed action is logged and the others are carried out; what it
// left undone is done again on a later pass.
package runpass

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/machineload"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/notices"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

// Fleet is the fleet as a pass calls it: the trierarch's crew:run calls, and a report with a session's crew token.
type Fleet interface {
	AssignedRequests() ([]reconciler.Request, error)
	Ship(shipID string) (fleet.Ship, error)
	StartingSecret(shipID string) (string, error)
	RegisterShip(shipID string, secret string, harness string) (string, error)
	Release(shipID string) error
	ConfirmRelease(shipID string) error
	WriteStatus(shipID string, status string, attempt int, startedAt string) error
	// GiveBack gives a request back; the fleet's refusal is answered, not failed.
	GiveBack(shipID string, settingsVersion int, reason string) (*fleet.Refusal, error)
	// Name is the trierarch's own ship's name.
	Name() (string, error)
	ReportFor(crewToken string, state string, note string) error
	Inbox(crewToken string) (reconciler.Inbox, error)
	// ReportToArgo tells argo; a key makes a retry safe.
	ReportToArgo(text string, idempotencyKey string) error
	// ReportToOwner tells a ship's owner; the fleet's refusal is answered, not failed.
	ReportToOwner(ownerShipID string, text string, idempotencyKey string) (*fleet.Refusal, error)
}

// Sockets are the ships' sockets, each session's fleet calls (decision 0026).
type Sockets interface {
	// Open opens the ship's socket, or keeps the one open, and answers its path.
	Open(shipID string) (string, error)
	Close(shipID string)
}

// Sessions are the sessions that run, as the passes list and stop them.
type Sessions interface {
	List() ([]sessions.Observed, error)
	Stop(shipID string) error
}

// Harness is one harness: its session's launch and launch window, and the session's identity through the aeolus-fleet plugin.
type Harness interface {
	// Launch starts the entry's session in its folder, with its first prompt on a first start and the wake otherwise.
	Launch(entry reconciler.Entry, isFirstStart bool, launchID string) error
	LaunchSeen(entry reconciler.Entry) reconciler.LaunchSeen
	WriteIdentity(folder string, identity plugin.Identity, crewToken string) error
	HasIdentity(folder string) bool
	DeleteIdentity(folder string) error
	SessionDied(folder string) error
	// Turn is the session's turn as its plugin marks it: busy, idle or unknown.
	Turn(folder string) string
	// IsHolding is whether the session's store holds a message to hand.
	IsHolding(folder string) bool
	// HandOver hands one message over to the idle session (#756); false when nothing is handed.
	HandOver(entry reconciler.Entry) (bool, error)
	// ForceOver hands a forced message over, its busy turn stopped first (decision 0040); false when nothing is handed.
	ForceOver(entry reconciler.Entry, isTurnBusy bool) (bool, error)
	// Problem is why no session of it can start on this machine now, nil when one can (#827).
	Problem() error
}

// Workspace makes and removes a ship's workspace.
type Workspace interface {
	Prepare(entry reconciler.Entry, shipName string) (string, error)
	Unsaved(folder string) ([]string, error)
	Remove(entry reconciler.Entry) error
}

// Logins are which login each session starts on and whether it can start on it now (api keys K5, K9).
type Logins interface {
	// LoginOf is the login a ship's next session starts on: its own, else its harness's default, else its subscription.
	LoginOf(harness string, shipName string) string
	// StartProblem is why a session of the harness, with the options, in the folder, cannot start on the login now, empty when it can.
	StartProblem(harness string, login string, options map[string]string, folder string) string
	IsKeyReady(harness string) bool
	// KeyState is where the harness's API key stands: none, ready, refused or outOfCredit, and since when for one its vendor's answer set.
	KeyState(harness string) (state string, at string)
}

// Proxy is the model proxy, kept running while it is needed (headless H16).
type Proxy interface {
	Keep(isNeeded bool) error
}

// Keys are the harnesses' API key files.
type Keys interface {
	Has(harness string) bool
}

// keyHarnesses are the harnesses that may hold an API key.
var keyHarnesses = []string{"claude-code", "codex"}

type Store interface {
	Load() (reconciler.State, error)
	Save(state reconciler.State) error
}

type Pass struct {
	Fleet     Fleet
	Sessions  Sessions
	Harnesses map[string]Harness
	Workspace Workspace
	Store     Store
	Log       func(line string)
	Now       func() time.Time
	// NewLaunchID is a launch id of its own for each start (#490).
	NewLaunchID func() string
	FleetURL    string
	// Sockets are the ships' sockets, which their identities name (decision 0026).
	Sockets      Sockets
	Offered      []string
	Repositories []string
	Folders      []string
	RunningCap   int
	// Logins are each session's login; every session starts on its subscription without.
	Logins Logins
	// Proxy runs while any harness in Keys holds a key; none is kept without.
	Proxy Proxy
	Keys  Keys
	// VersionOf is the version detection found of a harness, empty when it found none; asked only for a harness whose session refused its model.
	VersionOf func(harness string) string
	// Offers are, by harness, each option it offers now and its value names in order, read each pass: a model a session refused is offered no more (#382).
	Offers func() map[string]map[string][]string
	// RefuseModel keeps a model a session refused as refused for its harness's detected version.
	RefuseModel func(harness string, model string) error
	// SendReleasedUsage sends a released ship's last usage before its folder goes (the usage design, U9); it fails while the fleet does not take it, so the folder stays. None sends nothing.
	SendReleasedUsage func(entry reconciler.Entry) error
	// Load reads the machine's load, at most once a minute; none reads nothing (#400).
	Load *machineload.Reader
}

func (p Pass) loginOf(entry reconciler.Entry) string {
	if p.Logins == nil {
		return "subscription"
	}
	return p.Logins.LoginOf(entry.Harness, nameOf(entry))
}

// startProblem is why the entry's session cannot start on the login now, asked in its folder with its options, whose own settings count (api keys K6).
func (p Pass) startProblem(entry reconciler.Entry, login string) string {
	if p.Logins == nil {
		return ""
	}
	return p.Logins.StartProblem(entry.Harness, login, entry.Options, entry.Folder)
}

// keepProxy runs the proxy while any harness holds a key; a failure is logged, and the next pass tries again.
func (p Pass) keepProxy() {
	if p.Proxy == nil || p.Keys == nil {
		return
	}
	isNeeded := slices.ContainsFunc(keyHarnesses, p.Keys.Has)
	if err := p.Proxy.Keep(isNeeded); err != nil {
		p.Log("the model proxy: " + err.Error())
	}
}

// startedOn is the entry once a session started on the login at the time: the login before kept while it differs (api keys K8).
func startedOn(entry reconciler.Entry, login string, at string) reconciler.Entry {
	if entry.Login != "" && entry.Login != login {
		entry.EarlierLogins = append(append([]reconciler.EarlierLogin{}, entry.EarlierLogins...), reconciler.EarlierLogin{Login: entry.Login, Until: at})
	}
	entry.Login = login
	return entry
}

// nextAfterFailure is what a failed pass tells next to its reason.
const nextAfterFailure = "the next pass tries again; aeolus-trierarch status and list show where it stands"

// Run runs one pass; it fails only when it cannot load its saved state. A pass that cannot read what it reconciles is logged and kept in the state with its reason and since when, which a pass that succeeds clears.
func (p Pass) Run() error {
	p.keepProxy()
	p.watchLoad()
	state, err := p.Store.Load()
	if err != nil {
		return err
	}
	next, actions, err := p.reconcile(state)
	if err != nil {
		p.Log(fmt.Sprintf("The pass failed: %v; %s", err, nextAfterFailure))
		since := p.Now().UTC().Format(isoMillis)
		if next.PassFailure != nil {
			since = next.PassFailure.Since
		}
		next.PassFailure = &reconciler.PassFailure{Reason: err.Error(), Since: since}
		return p.Store.Save(next)
	}
	// An entry whose action fails is not acted on further this pass: its next actions build on it. A notice that fails is logged and nothing more: it does not hold the entry back.
	failed := map[string]bool{}
	for _, action := range actions {
		if failed[action.ShipID] {
			continue
		}
		if next, err = p.carryOut(next, action); err != nil {
			failed[action.ShipID] = failed[action.ShipID] || !isNotice(action.Kind)
			p.Log(fmt.Sprintf("%s of %s failed: %v", action.Kind, action.ShipID, err))
		}
	}
	return nil
}

// isNotice is whether an action only tells argo or an owner something.
func isNotice(kind reconciler.ActionKind) bool {
	return kind == reconciler.ModelRefused || kind == reconciler.IdentityGone || kind == reconciler.Crashed
}

// observe is what runs: the sessions, what each in its launch window did, and for each entry whose session runs its inbox and turn. An inbox is watched only while its session runs, a crewing one from the moment its session runs (#473); its socket is opened again, as after the trierarch stopped, since its session keeps running and calls over it (decision 0026).
func (p Pass) observe(state reconciler.State, running []sessions.Observed) (reconciler.Observed, map[string]string, error) {
	observed := reconciler.Observed{Sessions: []reconciler.Session{}, Launches: map[string]reconciler.LaunchSeen{}, Ships: map[string]reconciler.Seen{}, StartProblems: map[string]string{}}
	versions := map[string]string{}
	statusOf := map[string]string{}
	for _, session := range running {
		observed.Sessions = append(observed.Sessions, reconciler.Session{ShipID: session.ShipID, Status: session.Status, IsOtherVersion: session.IsOtherVersion})
		statusOf[session.ShipID] = session.Status
	}
	for _, shipID := range sortedIDs(state.Entries) {
		entry := state.Entries[shipID]
		harness, ok := p.Harnesses[entry.Harness]
		status, hasSession := statusOf[shipID]
		// Asked only of an entry whose session would start: a running session keeps the login it started with (K3).
		if entry.State == "restarting" || (entry.State == "running" && !hasSession) {
			if problem := p.startProblem(entry, p.loginOf(entry)); problem != "" {
				observed.StartProblems[shipID] = problem
			}
		}
		if !ok || entry.Folder == "" {
			continue
		}
		if entry.LaunchedAt != "" && status == reconciler.SessionRunning {
			launch := harness.LaunchSeen(entry)
			if launch.Kind == reconciler.LaunchRefused {
				// The model the settings picked is the one named, else the one the refusal names.
				if model := entry.Options[modelOption]; model != "" {
					launch.Model = model
				}
				if _, ok := versions[entry.Harness]; !ok && p.VersionOf != nil {
					versions[entry.Harness] = p.VersionOf(entry.Harness)
				}
			}
			observed.Launches[shipID] = launch
		}
		isWatched := (entry.State == "running" || (entry.State == "crewing" && hasSession)) && status != reconciler.SessionExited
		// Its identity is looked at too while the trierarch would report on its behalf, as when its session exits in this pass (#664). An entry with no crew token is crewed again, so its identity says nothing.
		holdsIdentity := entry.State == "running" || entry.State == "restarting" || entry.State == "crashed"
		if (!isWatched && !holdsIdentity) || entry.CrewToken == "" {
			continue
		}
		if !harness.HasIdentity(entry.Folder) {
			observed.WithoutIdentity = append(observed.WithoutIdentity, shipID)
			continue
		}
		if !isWatched {
			continue
		}
		if _, err := p.Sockets.Open(shipID); err != nil {
			return observed, versions, err
		}
		turn := harness.Turn(entry.Folder)
		// The store is asked only when a hand-over could follow.
		isHolding := turn == reconciler.TurnIdle && harness.IsHolding(entry.Folder)
		inbox, err := p.Fleet.Inbox(entry.CrewToken)
		if err != nil {
			return observed, versions, err
		}
		isKeyNotReady := entry.Login == "apiKey" && p.Logins != nil && !p.Logins.IsKeyReady(entry.Harness)
		observed.Ships[shipID] = reconciler.Seen{Inbox: inbox, Turn: turn, IsHolding: isHolding, IsKeyNotReady: isKeyNotReady}
	}
	return observed, versions, nil
}

// modelOption is the option that names the model a session launches with.
const modelOption = "model"

func sortedIDs(entries map[string]reconciler.Entry) []string {
	ids := make([]string, 0, len(entries))
	for id := range entries {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

func (p Pass) put(state reconciler.State, entry reconciler.Entry) (reconciler.State, error) {
	state.Entries[entry.ShipID] = entry
	return state, p.Store.Save(state)
}

func (p Pass) remove(state reconciler.State, shipID string) (reconciler.State, error) {
	delete(state.Entries, shipID)
	return state, p.Store.Save(state)
}

func (p Pass) harnessOf(entry reconciler.Entry) (Harness, error) {
	harness, ok := p.Harnesses[entry.Harness]
	if !ok {
		return nil, fmt.Errorf("no adapter for the harness %s", entry.Harness)
	}
	return harness, nil
}

func (p Pass) carryOut(state reconciler.State, action reconciler.Action) (reconciler.State, error) {
	entry, isEntry := state.Entries[action.ShipID]
	switch action.Kind {
	case reconciler.Crew:
		if !isEntry {
			return state, nil
		}
		return p.crew(state, entry, action.IsResumed)
	case reconciler.Launch:
		if !isEntry {
			return state, nil
		}
		return p.launch(state, entry)
	case reconciler.Stop:
		return state, p.Sessions.Stop(action.ShipID)
	case reconciler.Release:
		if !isEntry {
			return state, nil
		}
		return p.release(state, entry)
	case reconciler.Confirm:
		return state, p.Fleet.ConfirmRelease(action.ShipID)
	case reconciler.Forget:
		// Its worktree stays, as today's trierarch leaves it (an orphan).
		if err := p.Sessions.Stop(action.ShipID); err != nil {
			return state, err
		}
		if err := p.deleteIdentity(*action.Entry); err != nil {
			return state, err
		}
		p.Log(fmt.Sprintf("%s (%s): its request is no longer assigned here, so its session and identity ended; its worktree stays", nameOf(*action.Entry), action.ShipID))
		return p.remove(state, action.ShipID)
	case reconciler.WriteStatus:
		return state, p.Fleet.WriteStatus(action.ShipID, action.Status.Status, action.Status.Attempt, action.Status.StartedAt)
	case reconciler.Report:
		if !isEntry || entry.CrewToken == "" || entry.Folder == "" {
			return state, nil
		}
		harness, err := p.harnessOf(entry)
		if err != nil || !harness.HasIdentity(entry.Folder) {
			p.Log(fmt.Sprintf("%s (%s): not reported %s, as its folder holds no identity", nameOf(entry), entry.ShipID, action.Note))
			return state, nil
		}
		return state, p.Fleet.ReportFor(entry.CrewToken, "blocked", action.Note)
	case reconciler.GiveBack:
		return p.giveBack(state, action.ShipID, action.SettingsVersion, action.Reason, action.Entry)
	case reconciler.ModelRefused:
		return state, p.modelRefused(action)
	case reconciler.IdentityGone:
		return state, p.identityGone(action)
	case reconciler.Crashed:
		return state, p.crashed(action)
	case reconciler.Wake, reconciler.Force:
		if !isEntry || entry.Folder == "" {
			return state, nil
		}
		return state, p.handOver(entry, action)
	}
	return state, fmt.Errorf("no such action %s", action.Kind)
}

func nameOf(entry reconciler.Entry) string {
	if entry.ShipName != "" {
		return entry.ShipName
	}
	return entry.ShipID
}

// crew crews the ship (crew:run): once its harness can start a session, makes the workspace, gets its starting prompt and registers with the secret, so the session never sees it; writes the folder's identity and starts the harness, the status crewing, until its session shows activity in its launch window (#382). A ship another session crews before its crew is left; one gone is forgotten; a resumed crew whose ship is crewed holds it by its own lease, or lost its register reply, so the ship is released and crewed again.
func (p Pass) crew(state reconciler.State, entry reconciler.Entry, isResumed bool) (reconciler.State, error) {
	harness, err := p.harnessOf(entry)
	if err != nil {
		return state, err
	}
	ship, err := p.Fleet.Ship(entry.ShipID)
	if err != nil {
		return state, err
	}
	switch {
	case ship.Status == "notFound" || ship.Status == "retired":
		// Forgotten as a request no longer assigned here is.
		if err := p.Sessions.Stop(entry.ShipID); err != nil {
			return state, err
		}
		if err := p.deleteIdentity(entry); err != nil {
			return state, err
		}
		return p.remove(state, entry.ShipID)
	case ship.Status == "crewed" && !isResumed:
		p.Log(fmt.Sprintf("%s (%s): crewed by another session, so the trierarch leaves it", ship.Name, entry.ShipID))
		return p.remove(state, entry.ShipID)
	case ship.Status == "crewed":
		if err := p.Fleet.Release(entry.ShipID); err != nil {
			return state, err
		}
	}
	if entry.IsReleasedElsewhere {
		var err error
		if state, entry, err = p.freshAfterReleaseElsewhere(state, entry); err != nil {
			return state, err
		}
	}
	if err := p.Fleet.WriteStatus(entry.ShipID, "crewing", 0, ""); err != nil {
		return state, err
	}
	// Registered only once the crew can start, so a crew that cannot never takes the ship's lease (#827).
	if problem := harness.Problem(); problem != nil {
		return p.giveBack(state, entry.ShipID, entry.SettingsVersion, problem.Error(), &entry)
	}
	folder, err := p.Workspace.Prepare(entry, ship.Name)
	if err != nil {
		return state, err
	}
	// Kept at once, so a crew that stops here knows the workspace to remove.
	entry.ShipName, entry.Folder = ship.Name, folder
	if state, err = p.put(state, entry); err != nil {
		return state, err
	}
	// A login that cannot start it is this computer's state (api keys A5): given back at once, it may be crewed on another. Asked in its folder with its options, whose own settings count (K6).
	login := p.loginOf(entry)
	if problem := p.startProblem(entry, login); problem != "" {
		return p.giveBack(state, entry.ShipID, entry.SettingsVersion, problem, &entry)
	}
	secret, err := p.Fleet.StartingSecret(entry.ShipID)
	if err != nil {
		return state, err
	}
	crewToken, err := p.Fleet.RegisterShip(entry.ShipID, secret, entry.Harness)
	if err != nil {
		return state, err
	}
	// The crew token stays in the state; the session calls over its ship's socket (decision 0026).
	entry.CrewToken = crewToken
	if state, err = p.put(state, entry); err != nil {
		return state, err
	}
	socket, err := p.Sockets.Open(entry.ShipID)
	if err != nil {
		return state, err
	}
	identity := plugin.Identity{FleetURL: p.FleetURL, ShipID: entry.ShipID, ShipName: ship.Name, Socket: socket, Squadron: entry.Squadron}
	if err := harness.WriteIdentity(folder, identity, crewToken); err != nil {
		return state, err
	}
	launchID := p.NewLaunchID()
	starting := entry
	starting.Login = login
	if err := harness.Launch(starting, !entry.HasStarted, launchID); err != nil {
		return state, err
	}
	entry.HasStarted, entry.LaunchedAt, entry.LaunchID = true, p.Now().Format(time.RFC3339Nano), launchID
	entry = startedOn(entry, login, entry.LaunchedAt)
	p.Log(fmt.Sprintf("%s (%s): crewed, %s started in %s", ship.Name, entry.ShipID, entry.Harness, folder))
	return p.put(state, entry)
}

// freshAfterReleaseElsewhere removes the workspace of a ship released elsewhere before it is crewed again in a fresh one (row 11, #475), argo told first what that discards. The entry is saved without its mark only once that is done, so a failed removal is tried again on the next pass.
func (p Pass) freshAfterReleaseElsewhere(state reconciler.State, entry reconciler.Entry) (reconciler.State, reconciler.Entry, error) {
	if err := p.endWorkspace(entry, notices.DiscardedElsewhere); err != nil {
		return state, entry, err
	}
	p.Log(fmt.Sprintf("%s (%s): released elsewhere, its worktree removed", nameOf(entry), entry.ShipID))
	entry.IsReleasedElsewhere = false
	state, err := p.put(state, entry)
	return state, entry, err
}

// launch starts the entry's session again in its folder, continuing, its first minute checked from now (#397). The session that held its messages is gone: its store marks them for the session started now (#756).
func (p Pass) launch(state reconciler.State, entry reconciler.Entry) (reconciler.State, error) {
	harness, err := p.harnessOf(entry)
	if err != nil || entry.Folder == "" {
		return state, err
	}
	if err := harness.SessionDied(entry.Folder); err != nil {
		return state, err
	}
	launchID := p.NewLaunchID()
	login := p.loginOf(entry)
	starting := entry
	starting.Login = login
	if err := harness.Launch(starting, false, launchID); err != nil {
		return state, err
	}
	entry.LaunchedAt, entry.LaunchID = p.Now().Format(time.RFC3339Nano), launchID
	entry = startedOn(entry, login, entry.LaunchedAt)
	p.Log(fmt.Sprintf("%s (%s): started again in %s", nameOf(entry), entry.ShipID, entry.Folder))
	return p.put(state, entry)
}

// release ends what a removed request held (row 7): the session stops, the lease ends, then the workspace goes; only then is the request confirmed.
func (p Pass) release(state reconciler.State, entry reconciler.Entry) (reconciler.State, error) {
	if err := p.Sessions.Stop(entry.ShipID); err != nil {
		return state, err
	}
	ship, err := p.Fleet.Ship(entry.ShipID)
	if err != nil {
		return state, err
	}
	if ship.Status == "crewed" {
		if err := p.Fleet.Release(entry.ShipID); err != nil {
			return state, err
		}
	}
	if err := p.endWorkspace(entry, notices.Discarded); err != nil {
		return state, err
	}
	if state, err = p.remove(state, entry.ShipID); err != nil {
		return state, err
	}
	if err := p.Fleet.ConfirmRelease(entry.ShipID); err != nil {
		return state, err
	}
	p.Log(fmt.Sprintf("%s (%s): released, its worktree removed", nameOf(entry), entry.ShipID))
	return state, nil
}

// giveBack gives back a request it cannot crew, with why; the entry it crewed with ends first.
func (p Pass) giveBack(state reconciler.State, shipID string, settingsVersion int, reason string, entry *reconciler.Entry) (reconciler.State, error) {
	if entry != nil {
		if err := p.Sessions.Stop(shipID); err != nil {
			return state, err
		}
		if err := p.deleteIdentity(*entry); err != nil {
			return state, err
		}
		// A worktree with changes is kept, reported by the state's kept worktrees, as today's trierarch keeps it.
		if entry.Folder != "" && entry.Workspace.Kind == "worktree" {
			unsaved, err := p.Workspace.Unsaved(entry.Folder)
			if err != nil {
				return state, err
			}
			if len(unsaved) == 0 {
				if err := p.Workspace.Remove(*entry); err != nil {
					return state, err
				}
			} else {
				p.Log(fmt.Sprintf("Kept the worktree of %s, which has changes: %s", shipID, entry.Folder))
				state.Kept = append(state.Kept, map[string]any{"shipId": shipID, "repository": entry.Workspace.Repository, "path": entry.Folder})
			}
		}
		var err error
		if state, err = p.remove(state, shipID); err != nil {
			return state, err
		}
	}
	name, err := p.Fleet.Name()
	if err != nil {
		return state, err
	}
	given := cutToUTF16(name+": "+reason, reasonMaxLength)
	refusal, err := p.Fleet.GiveBack(shipID, settingsVersion, given)
	if err != nil {
		return state, err
	}
	if refusal != nil {
		p.Log(fmt.Sprintf("The fleet refused to take back the crew request of %s: %s: %s", shipID, refusal.Code, refusal.Message))
		return p.refuse(state, shipID, settingsVersion, reason)
	}
	p.Log(fmt.Sprintf("%s: given back, %s", shipID, given))
	return state, nil
}

// reasonMaxLength is how long a given-back reason may be, in the UTF-16 units a JavaScript string counts them in, as the fleet counts them.
const reasonMaxLength = 200

// cutToUTF16 cuts text to at most length UTF-16 units, as today's trierarch cuts it with slice.
func cutToUTF16(text string, length int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= length {
		return text
	}
	return string(utf16.Decode(units[:length]))
}

// refuse keeps a request the trierarch cannot crew, and the fleet will not take back, as refused at its settings version, and tells its ship's owner once.
func (p Pass) refuse(state reconciler.State, shipID string, settingsVersion int, why string) (reconciler.State, error) {
	ship, err := p.Fleet.Ship(shipID)
	if err != nil {
		return state, err
	}
	named := notices.Ship{ID: shipID, Name: ship.Name}
	key := fmt.Sprintf("trierarch:refused:%s:%d", shipID, settingsVersion)
	if _, err := p.reportTrouble(named, key, func(bool) string { return notices.SettingsRefused(named, settingsVersion, why) }); err != nil {
		return state, err
	}
	state.Refused = maps.Clone(state.Refused)
	if state.Refused == nil {
		state.Refused = map[string]int{}
	}
	state.Refused[shipID] = settingsVersion
	p.Log(fmt.Sprintf("Cannot crew %s (%s), settings version %d: %s", nameOfShip(named), shipID, settingsVersion, why))
	return state, p.Store.Save(state)
}

// handOver hands a message over to the entry's session, forced or not.
func (p Pass) handOver(entry reconciler.Entry, action reconciler.Action) error {
	harness, err := p.harnessOf(entry)
	if err != nil {
		return err
	}
	var isHanded bool
	if action.Kind == reconciler.Force {
		isHanded, err = harness.ForceOver(entry, action.IsTurnBusy)
	} else {
		isHanded, err = harness.HandOver(entry)
	}
	if err != nil || !isHanded {
		return err
	}
	switch {
	case action.Kind == reconciler.Wake:
		p.Log(fmt.Sprintf("%s (%s): handed a message over", nameOf(entry), entry.ShipID))
	case action.IsTurnBusy:
		p.Log(fmt.Sprintf("%s (%s): stopped its turn and handed a forced message over", nameOf(entry), entry.ShipID))
	default:
		p.Log(fmt.Sprintf("%s (%s): handed a forced message over", nameOf(entry), entry.ShipID))
	}
	return nil
}

// deleteIdentity removes the entry's identity, and with it its ship's socket, as nothing calls over it any more (decision 0026).
func (p Pass) deleteIdentity(entry reconciler.Entry) error {
	p.Sockets.Close(entry.ShipID)
	if entry.Folder == "" {
		return nil
	}
	if harness, err := p.harnessOf(entry); err == nil && harness.HasIdentity(entry.Folder) {
		return harness.DeleteIdentity(entry.Folder)
	}
	return nil
}

// endWorkspace sends a released entry's last usage, removes its identity, and a worktree it made, whatever that holds, logged first, as a release does (#450). A configured folder is never removed.
func (p Pass) endWorkspace(entry reconciler.Entry, told func(notices.Ship, string, []string) string) error {
	// Its usage goes first: what it used since the last send would be lost with the folder.
	if entry.Folder != "" && p.SendReleasedUsage != nil {
		if err := p.SendReleasedUsage(entry); err != nil {
			return err
		}
	}
	if err := p.deleteIdentity(entry); err != nil {
		return err
	}
	if entry.Folder == "" || entry.Workspace.Kind != "worktree" {
		return nil
	}
	if unsaved, err := p.Workspace.Unsaved(entry.Folder); err == nil && len(unsaved) > 0 {
		p.Log(fmt.Sprintf("Discarded from the worktree of %s (%s), %s: %s", nameOf(entry), entry.ShipID, entry.Folder, strings.Join(unsaved, "; ")))
		// Told before the worktree goes, once per release; a failure to tell leaves the worktree for the next pass.
		text := told(notices.Ship{ID: entry.ShipID, Name: entry.ShipName}, entry.Workspace.Repository, unsaved)
		if err := p.Fleet.ReportToArgo(text, "trierarch:discarded:"+entry.ShipID+":"+entry.Since); err != nil {
			return err
		}
	}
	return p.Workspace.Remove(entry)
}

// modelRefused keeps the model a session refused as refused at its harness's version, so this machine offers it no more, and tells argo once per harness, version and model (#382).
func (p Pass) modelRefused(action reconciler.Action) error {
	if err := p.RefuseModel(action.Harness, action.Model); err != nil {
		return err
	}
	ship := notices.Ship{ID: action.ShipID, Name: action.ShipName}
	key := fmt.Sprintf("trierarch:refused-model:%s:%s:%s", action.Harness, action.Version, action.Model)
	if err := p.Fleet.ReportToArgo(notices.ModelRefused(ship, action.Harness, action.Version, action.Model), key); err != nil {
		return err
	}
	p.Log(fmt.Sprintf("%s (%s): %s %s refused %s, offered no more at this version", nameOfShip(ship), action.ShipID, action.Harness, action.Version, action.Model))
	return nil
}

// identityGone tells argo that a ship's folder holds no identity: the trierarch cannot report on its behalf or see its inbox, so nothing wakes it while its lease holds (#659, #664).
func (p Pass) identityGone(action reconciler.Action) error {
	ship := notices.Ship{ID: action.ShipID, Name: action.ShipName}
	key := fmt.Sprintf("trierarch:identity-gone:%s:%s", action.ShipID, p.Now().UTC().Format(isoMillis))
	if err := p.Fleet.ReportToArgo(notices.IdentityGone(ship), key); err != nil {
		return err
	}
	p.Log(fmt.Sprintf("%s (%s): its folder holds no identity, so it is no longer woken; argo told", nameOfShip(ship), action.ShipID))
	return nil
}

// isoMillis is a time as today's trierarch writes it in a key, to the millisecond in UTC.
const isoMillis = "2006-01-02T15:04:05.000Z"

func nameOfShip(ship notices.Ship) string {
	if ship.Name != "" {
		return ship.Name
	}
	return ship.ID
}

// argoName is argo's name: trouble of a ship argo owns, or of one with no owner, goes to argo by name.
const argoName = "argo"

// crashed tells the ship's owner its session's restart budget is spent (decision 0045): its owner as the fleet holds it now, argo when argo owns it. When the fleet refuses the report to a person's ship, as when no rule lets this trierarch reach it, argo is told instead, with why.
func (p Pass) crashed(action reconciler.Action) error {
	ship := notices.Ship{ID: action.ShipID, Name: action.ShipName}
	told, err := p.reportTrouble(ship, action.Key, func(isForArgo bool) string {
		return notices.Crash(ship, action.Exits, action.FailedStart, isForArgo)
	})
	if err != nil {
		return err
	}
	p.Log(fmt.Sprintf("%s (%s): crashed, its restart budget spent; %s told", nameOfShip(ship), action.ShipID, told))
	return nil
}

// reportTrouble tells a ship's owner of trouble with its crew and answers the name of the ship told.
func (p Pass) reportTrouble(ship notices.Ship, key string, text func(isForArgo bool) string) (string, error) {
	requests, err := p.Fleet.AssignedRequests()
	if err != nil {
		return "", err
	}
	var ownerID, ownerName string
	for _, request := range requests {
		if request.ShipID == ship.ID && request.OwnerShipID != nil && request.OwnerName != nil {
			ownerID, ownerName = *request.OwnerShipID, *request.OwnerName
		}
	}
	if ownerID == "" || ownerName == argoName {
		return argoName, p.Fleet.ReportToArgo(text(true), key)
	}
	refusal, err := p.Fleet.ReportToOwner(ownerID, text(false), key)
	if err != nil {
		return "", err
	}
	if refusal == nil {
		return ownerName, nil
	}
	p.Log(fmt.Sprintf("Could not reach %s (%s), the owner of %s (%s): %s: %s; argo is told instead", ownerName, ownerID, nameOfShip(ship), ship.ID, refusal.Code, refusal.Message))
	return argoName, p.Fleet.ReportToArgo(notices.OwnerUnreachable(text(true), ownerName, refusal.Code, refusal.Message), key+":owner-unreachable")
}

// tellKeysNotReady tells argo once per harness and state of its API key while ships on it wait (api keys K9): the harness, the state since when and those ships. A key ready again is forgotten, so a later state is told again; a key no ship here is on is nobody's concern. A failure to tell is logged and tried again on the next pass.
func (p Pass) tellKeysNotReady(state reconciler.State) (reconciler.State, error) {
	if p.Logins == nil {
		return state, nil
	}
	onKey := []reconciler.Entry{}
	for _, shipID := range sortedIDs(state.Entries) {
		entry := state.Entries[shipID]
		login := entry.Login
		if login == "" {
			login = p.loginOf(entry)
		}
		if login == "apiKey" {
			onKey = append(onKey, entry)
		}
	}
	harnesses := []string{}
	for _, entry := range onKey {
		if !slices.Contains(harnesses, entry.Harness) {
			harnesses = append(harnesses, entry.Harness)
		}
	}
	slices.Sort(harnesses)
	told := map[string]string{}
	for _, harness := range harnesses {
		key, at := p.Logins.KeyState(harness)
		if key == "ready" {
			continue
		}
		if state.KeysTold[harness] == key {
			told[harness] = key
			continue
		}
		ships := []notices.Ship{}
		for _, entry := range onKey {
			if entry.Harness == harness {
				ships = append(ships, notices.Ship{ID: entry.ShipID, Name: entry.ShipName})
			}
		}
		if err := p.Fleet.ReportToArgo(notices.KeyNotReady(harness, key, at, ships), fmt.Sprintf("trierarch:key:%s:%s:%s", harness, key, at)); err != nil {
			p.Log(fmt.Sprintf("Could not tell argo that %s's API key is not ready: %v", harness, err))
			continue
		}
		told[harness] = key
	}
	if maps.Equal(told, state.KeysTold) || (len(told) == 0 && len(state.KeysTold) == 0) {
		return state, nil
	}
	if len(told) == 0 {
		told = nil
	}
	state.KeysTold = told
	return state, p.Store.Save(state)
}

// reconcile reads the requests, what runs and the ships' inboxes, saves what the reconciler made of them and answers the actions to carry out. It answers the latest state it saved, or was given, with the error.
func (p Pass) reconcile(state reconciler.State) (reconciler.State, []reconciler.Action, error) {
	requests, err := p.Fleet.AssignedRequests()
	if err != nil {
		return state, nil, err
	}
	running, err := p.Sessions.List()
	if err != nil {
		return state, nil, err
	}
	observed, versions, err := p.observe(state, running)
	if err != nil {
		return state, nil, err
	}
	now := p.Now()
	next, actions := reconciler.Reconcile(state, reconciler.Context{Requests: requests, Observed: observed, Now: now, Harnesses: p.Offered, Repositories: p.Repositories, Folders: p.Folders, RunningCap: p.RunningCap, Versions: versions, Options: p.Offers()})
	next.PassFailure = nil
	if err := p.Store.Save(next); err != nil {
		return state, nil, err
	}
	if next, err = p.tellKeysNotReady(next); err != nil {
		return next, nil, err
	}
	return next, actions, nil
}

// watchLoad reads the machine's load and tells argo each resource it started to be low on, once: again only after it recovered and dropped again. What argo was told is kept in the state, so a restart while it stays low tells nothing. A failure is logged; the next read tries again (#400).
func (p Pass) watchLoad() {
	if p.Load == nil {
		return
	}
	load, isFresh := p.Load.Read()
	if load == nil || !isFresh {
		return
	}
	if err := p.tellLow(*load); err != nil {
		p.Log("Could not tell argo the machine is low: " + err.Error())
	}
}

func (p Pass) tellLow(load machineload.Load) error {
	state, err := p.Store.Load()
	if err != nil {
		return err
	}
	low := load.Low()
	for _, resource := range low {
		if slices.Contains(state.LowResources, resource) {
			continue
		}
		key := "low-" + resource + "-" + p.Now().UTC().Format(isoMillis)
		if err := p.Fleet.ReportToArgo(notices.LowResource(resource, load), key); err != nil {
			return err
		}
	}
	if slices.Equal(low, state.LowResources) || (len(low) == 0 && len(state.LowResources) == 0) {
		return nil
	}
	state.LowResources = low
	return p.Store.Save(state)
}
