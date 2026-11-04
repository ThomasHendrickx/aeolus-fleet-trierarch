// Package runpass is one pass of the run loop: it reads the crew requests
// assigned to the trierarch, its saved state and what runs, asks the
// reconciler what to do, and carries the actions out, saving the state as it
// goes. A failed action is logged and the others are carried out; what it
// left undone is done again on a later pass.
package runpass

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
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
	GiveBack(shipID string, settingsVersion int, reason string) error
	ReportFor(crewToken string, state string, note string) error
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
	// Problem is why no session of it can start on this machine now, nil when one can (#827).
	Problem() error
}

// Workspace makes and removes a ship's workspace.
type Workspace interface {
	Prepare(entry reconciler.Entry, shipName string) (string, error)
	Unsaved(folder string) ([]string, error)
	Remove(entry reconciler.Entry) error
}

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
	// Sockets is the folder of each ship's socket, which its identity names (decision 0026).
	Sockets      string
	Offered      []string
	Repositories []string
	Folders      []string
	RunningCap   int
}

// Run runs one pass; it fails only when it cannot read what it reconciles.
func (p Pass) Run() error {
	requests, err := p.Fleet.AssignedRequests()
	if err != nil {
		return err
	}
	state, err := p.Store.Load()
	if err != nil {
		return err
	}
	running, err := p.Sessions.List()
	if err != nil {
		return err
	}
	observed := reconciler.Observed{Sessions: []reconciler.Session{}, Launches: map[string]reconciler.LaunchSeen{}}
	for _, session := range running {
		observed.Sessions = append(observed.Sessions, reconciler.Session{ShipID: session.ShipID, Status: session.Status})
	}
	for shipID, entry := range state.Entries {
		harness, ok := p.Harnesses[entry.Harness]
		if !ok || entry.LaunchedAt == "" || entry.Folder == "" || !isRunning(running, shipID) {
			continue
		}
		observed.Launches[shipID] = harness.LaunchSeen(entry)
	}
	now := p.Now()
	next, actions := reconciler.Reconcile(state, reconciler.Context{Requests: requests, Observed: observed, Now: now, Harnesses: p.Offered, Repositories: p.Repositories, Folders: p.Folders, RunningCap: p.RunningCap})
	if err := p.Store.Save(next); err != nil {
		return err
	}
	// An entry whose action fails is not acted on further this pass: its next actions build on it.
	failed := map[string]bool{}
	for _, action := range actions {
		if failed[action.ShipID] {
			continue
		}
		if next, err = p.carryOut(next, action); err != nil {
			failed[action.ShipID] = true
			p.Log(fmt.Sprintf("%s of %s failed: %v", action.Kind, action.ShipID, err))
		}
	}
	return nil
}

func isRunning(observed []sessions.Observed, shipID string) bool {
	for _, session := range observed {
		if session.ShipID == shipID && session.Status == reconciler.SessionRunning {
			return true
		}
	}
	return false
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
		return state, nil
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
	identity := plugin.Identity{FleetURL: p.FleetURL, ShipID: entry.ShipID, ShipName: ship.Name, Socket: filepath.Join(p.Sockets, entry.ShipID, "fleet.sock"), Squadron: entry.Squadron}
	if err := harness.WriteIdentity(folder, identity, crewToken); err != nil {
		return state, err
	}
	launchID := p.NewLaunchID()
	if err := harness.Launch(entry, !entry.HasStarted, launchID); err != nil {
		return state, err
	}
	entry.HasStarted, entry.LaunchedAt, entry.LaunchID = true, p.Now().Format(time.RFC3339Nano), launchID
	p.Log(fmt.Sprintf("%s (%s): crewed, %s started in %s", ship.Name, entry.ShipID, entry.Harness, folder))
	return p.put(state, entry)
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
	if err := harness.Launch(entry, false, launchID); err != nil {
		return state, err
	}
	entry.LaunchedAt, entry.LaunchID = p.Now().Format(time.RFC3339Nano), launchID
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
	if err := p.endWorkspace(entry); err != nil {
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
	if err := p.Fleet.GiveBack(shipID, settingsVersion, reason); err != nil {
		return state, err
	}
	p.Log(fmt.Sprintf("%s: given back, %s", shipID, reason))
	return state, nil
}

func (p Pass) deleteIdentity(entry reconciler.Entry) error {
	if entry.Folder == "" {
		return nil
	}
	if harness, err := p.harnessOf(entry); err == nil && harness.HasIdentity(entry.Folder) {
		return harness.DeleteIdentity(entry.Folder)
	}
	return nil
}

// endWorkspace removes the entry's identity, and a worktree it made, whatever that holds, logged first, as a release does (#450). A configured folder is never removed.
func (p Pass) endWorkspace(entry reconciler.Entry) error {
	if err := p.deleteIdentity(entry); err != nil {
		return err
	}
	if entry.Folder == "" || entry.Workspace.Kind != "worktree" {
		return nil
	}
	if unsaved, err := p.Workspace.Unsaved(entry.Folder); err == nil && len(unsaved) > 0 {
		p.Log(fmt.Sprintf("Discarded from the worktree of %s (%s), %s: %s", nameOf(entry), entry.ShipID, entry.Folder, strings.Join(unsaved, "; ")))
	}
	return p.Workspace.Remove(entry)
}
