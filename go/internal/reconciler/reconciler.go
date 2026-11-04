// Package reconciler is the Go trierarch's Reconciler (docs/architecture.md,
// "The trierarch"): a pure function from the crew requests assigned to the
// trierarch, its saved state, what runs and the time to the actions that make
// them match, and the state those actions start from. It is the only place
// that decides; the run pass only carries the actions out. It reads no clock
// and touches nothing outside itself.
package reconciler

import (
	"fmt"
	"slices"
	"time"
)

// State is the trierarch's saved state, in the shape today's trierarch saves
// it (state.json): an entry per ship it crews, by ship id. The fields this
// trierarch does not use yet are kept as they were read.
type State struct {
	Entries map[string]Entry `json:"entries"`
	Kept    []any            `json:"kept"`
	Orphans []any            `json:"orphans"`
	Refused map[string]int   `json:"refused"`
}

// Empty is the state of a trierarch that crewed nothing yet.
func Empty() State {
	return State{Entries: map[string]Entry{}, Kept: []any{}, Orphans: []any{}, Refused: map[string]int{}}
}

// Workspace is where a crew request's session works: a worktree of a configured repository, or a configured folder.
type Workspace struct {
	Kind       string `json:"kind"`
	Repository string `json:"repository,omitempty"`
	Ref        string `json:"ref,omitempty"`
	Name       string `json:"name,omitempty"`
}

// Entry is one ship the trierarch crews, from the crew request assigned to it, with the settings of the version it crewed.
type Entry struct {
	ShipID          string            `json:"shipId"`
	ShipName        string            `json:"shipName,omitempty"`
	SettingsVersion int               `json:"settingsVersion"`
	Harness         string            `json:"harness"`
	Workspace       Workspace         `json:"workspace"`
	Squadron        string            `json:"squadron,omitempty"`
	FirstPrompt     string            `json:"firstPrompt,omitempty"`
	Options         map[string]string `json:"options"`
	// State is crewing, running, restarting, crashed or releasing.
	State string `json:"state"`
	// Since is when the entry took its state, ISO 8601.
	Since string `json:"since"`
	// Exits are when its session exited within the restart window, oldest first.
	Exits     []string `json:"exits"`
	RestartAt string   `json:"restartAt,omitempty"`
	Folder    string   `json:"folder,omitempty"`
	// CrewToken is the one its register gave, kept in the state only (decision 0026).
	CrewToken  string `json:"crewToken,omitempty"`
	HasStarted bool   `json:"hasStarted"`
	// LaunchedAt and LaunchID are set while its session's launch window is open (#382, #490).
	LaunchedAt string `json:"launchedAt,omitempty"`
	LaunchID   string `json:"launchId,omitempty"`
}

// Settings are a crew request's settings as the trierarch reads them (decision 0027).
type Settings struct {
	Harness     string            `json:"harness,omitempty"`
	Workspace   Workspace         `json:"workspace"`
	Squadron    string            `json:"squadron,omitempty"`
	FirstPrompt string            `json:"firstPrompt,omitempty"`
	Options     map[string]string `json:"options,omitempty"`
}

// Request is a crew request assigned to the trierarch, as the fleet answers it.
type Request struct {
	ShipID          string   `json:"shipId"`
	Settings        Settings `json:"settings"`
	SettingsVersion int      `json:"settingsVersion"`
	// Status is the crew status the fleet holds, none before the first is written.
	Status  *string `json:"status"`
	IsFinal bool    `json:"isFinal"`
}

const (
	SessionRunning = "running"
	SessionExited  = "exited"
)

// Session is a ship's session as the trierarch sees it: running, or exited and not yet started again; of another version when another version of the trierarch started its hold (H19).
type Session struct {
	ShipID         string
	Status         string
	IsOtherVersion bool
}

const (
	TurnIdle    = "idle"
	TurnBusy    = "busy"
	TurnUnknown = "unknown"
)

// Inbox is what a session's inbox says: deliveries waiting, of them those forced and not handed over yet (decision 0040), or the lease ended.
type Inbox struct {
	IsLeaseEnded bool
	Waiting      int
	Forced       int
}

// Seen is what the trierarch saw of a watched session: its inbox, its turn as the plugin marks it, and whether its store holds a message to hand.
type Seen struct {
	Inbox     Inbox
	Turn      string
	IsHolding bool
}

const (
	LaunchActive = "active"
	LaunchNone   = "none"
)

// Launch is what a session in its launch window did, as the plugin's launch marker says: active at its first tool call, or nothing yet, with the cause its harness gave.
type LaunchSeen struct {
	Kind  string
	Cause string
}

// Observed is what the trierarch saw this pass.
type Observed struct {
	Sessions []Session
	// Launches are, by ship id, what each session in its launch window did.
	Launches map[string]LaunchSeen
	// Ships are, by ship id, what was seen of each watched session.
	Ships map[string]Seen
}

// Context is what reconciling needs beside the state.
type Context struct {
	Requests []Request
	Observed Observed
	Now      time.Time
	// Harnesses are the ones the configuration offers, the default first.
	Harnesses    []string
	Repositories []string
	Folders      []string
	RunningCap   int
}

type ActionKind string

const (
	// Crew the ship: starting prompt, register, workspace, identity, launch; resumed while its own lease may still hold the ship.
	Crew ActionKind = "crew"
	// Launch starts its session again in its folder, continuing.
	Launch ActionKind = "launch"
	Stop   ActionKind = "stop"
	// Release ends what a removed request held: the session, the lease, the workspace, then confirms.
	Release ActionKind = "release"
	// Confirm confirms a removed request it does not crew.
	Confirm ActionKind = "confirm"
	// Forget ends what a request no longer assigned here held: the session, the identity and the worktree.
	Forget      ActionKind = "forget"
	WriteStatus ActionKind = "status"
	// Report reports on the ship's behalf, with its session's crew token.
	Report ActionKind = "report"
	// GiveBack gives back a request it cannot crew while its crew is not final, with why; its entry ends first.
	GiveBack ActionKind = "giveBack"
	// Wake hands one message over to an idle session (#756).
	Wake ActionKind = "wake"
	// Force hands a forced message over, its busy turn stopped first (decision 0040).
	Force ActionKind = "force"
)

// Status is a crew status as the trierarch writes it (#332).
type Status struct {
	Status  string
	Attempt int
	// StartedAt is when the session running now started; empty while none runs.
	StartedAt string
}

type Action struct {
	Kind            ActionKind
	ShipID          string
	IsResumed       bool
	IsTurnBusy      bool
	Status          Status
	Note            string
	SettingsVersion int
	Reason          string
	// Entry is the entry that ends with a forget or a give back.
	Entry *Entry
}

// LaunchWindow is how long after its start a session has to show activity (#382).
const LaunchWindow = time.Minute

// RestartDelays are the waits before each restart in the window, then the last one for every later restart.
var RestartDelays = []time.Duration{5 * time.Second, 30 * time.Second, 2 * time.Minute, 10 * time.Minute}

// RestartBudget is how many restarts an hour a session gets before its entry is crashed.
const RestartBudget = 5

const RestartWindow = time.Hour

const (
	restartingNote   = "blocked: session crashed, restarting"
	crashedNote      = "blocked: session crashed, restart budget spent"
	noActivityReason = "no activity within a minute of its start"
)

func stamp(at time.Time) string {
	return at.Format(time.RFC3339Nano)
}

func parsed(text string) time.Time {
	at, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return time.Time{}
	}
	return at
}

// written are the states whose status the reconciler writes; crewing is the crew's own to write.
var written = []string{"running", "restarting", "crashed"}

type step struct {
	entry       *Entry
	isGivenBack bool
	actions     []Action
	starts      int
}

// Reconcile answers the state the actions start from and the actions, in order.
func Reconcile(state State, context Context) (State, []Action) {
	requested := map[string]Request{}
	for _, request := range context.Requests {
		requested[request.ShipID] = request
	}
	next := State{Entries: map[string]Entry{}, Kept: state.Kept, Orphans: state.Orphans, Refused: state.Refused}
	actions := []Action{}
	runningSessions := 0
	for _, session := range context.Observed.Sessions {
		if _, ok := state.Entries[session.ShipID]; ok && session.Status == SessionRunning {
			runningSessions++
		}
	}
	canStart := func() bool { return runningSessions < context.RunningCap }

	for _, shipID := range sortedKeys(state.Entries) {
		entry := state.Entries[shipID]
		request, ok := requested[shipID]
		if !ok {
			forgotten := entry
			actions = append(actions, Action{Kind: Forget, ShipID: shipID, Entry: &forgotten})
			continue
		}
		if request.Status != nil && *request.Status == "releasing" {
			next.Entries[shipID] = entry
			actions = append(actions, Action{Kind: Release, ShipID: shipID})
			continue
		}
		var taken step
		if request.SettingsVersion == entry.SettingsVersion {
			taken = stepOf(entry, context, canStart(), request.IsFinal)
		} else {
			taken = newVersionStep(entry, request, context)
		}
		actions = append(actions, taken.actions...)
		if taken.isGivenBack {
			continue
		}
		after := entry
		if taken.entry != nil {
			after = *taken.entry
		}
		next.Entries[shipID] = after
		if slices.Contains(written, after.State) && (request.Status == nil || *request.Status != after.State) {
			actions = append(actions, Action{Kind: WriteStatus, ShipID: shipID, Status: statusOf(after)})
		}
		runningSessions += taken.starts
	}

	for _, request := range context.Requests {
		if _, ok := state.Entries[request.ShipID]; ok {
			continue
		}
		if request.Status != nil && *request.Status == "releasing" {
			actions = append(actions, Action{Kind: Confirm, ShipID: request.ShipID})
			continue
		}
		harness, reason := check(request.Settings, context)
		if reason != "" {
			if !request.IsFinal {
				actions = append(actions, Action{Kind: GiveBack, ShipID: request.ShipID, SettingsVersion: request.SettingsVersion, Reason: reason})
			}
			continue
		}
		if canStart() {
			next.Entries[request.ShipID] = entryOf(request, harness, context.Now)
			actions = append(actions, Action{Kind: Crew, ShipID: request.ShipID})
			runningSessions++
		}
	}

	for _, session := range context.Observed.Sessions {
		if _, ok := state.Entries[session.ShipID]; !ok {
			actions = append(actions, Action{Kind: Stop, ShipID: session.ShipID})
		}
	}
	return next, actions
}

func sortedKeys(entries map[string]Entry) []string {
	keys := make([]string, 0, len(entries))
	for key := range entries {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

// check answers the harness settings crew with, or why this machine cannot crew them, naming the field at fault.
func check(settings Settings, context Context) (string, string) {
	harness := settings.Harness
	if harness == "" && len(context.Harnesses) > 0 {
		harness = context.Harnesses[0]
	}
	if !slices.Contains(context.Harnesses, harness) {
		return "", fmt.Sprintf("harness: %s is not offered on this machine", harness)
	}
	switch settings.Workspace.Kind {
	case "worktree":
		if !slices.Contains(context.Repositories, settings.Workspace.Repository) {
			return "", fmt.Sprintf("workspace.repository: %s is not configured on this machine", settings.Workspace.Repository)
		}
	case "folder":
		if !slices.Contains(context.Folders, settings.Workspace.Name) {
			return "", fmt.Sprintf("workspace.name: %s is not configured on this machine", settings.Workspace.Name)
		}
	default:
		return "", fmt.Sprintf("workspace.kind: %s is no workspace", settings.Workspace.Kind)
	}
	return harness, ""
}

func entryOf(request Request, harness string, now time.Time) Entry {
	options := request.Settings.Options
	if options == nil {
		options = map[string]string{}
	}
	return Entry{
		ShipID:          request.ShipID,
		SettingsVersion: request.SettingsVersion,
		Harness:         harness,
		Workspace:       request.Settings.Workspace,
		Squadron:        request.Settings.Squadron,
		FirstPrompt:     request.Settings.FirstPrompt,
		Options:         options,
		State:           "crewing",
		Since:           stamp(now),
		Exits:           []string{},
	}
}

// statusOf is the status an entry writes: its state, its restart attempt, and when its session started while it runs.
func statusOf(entry Entry) Status {
	attempt := len(entry.Exits)
	if entry.State == "crashed" {
		attempt = max(0, attempt-1)
	}
	written := Status{Status: entry.State, Attempt: attempt}
	if entry.State == "running" {
		written.StartedAt = entry.Since
	}
	return written
}

func withState(entry Entry, state string, now time.Time) Entry {
	entry.State, entry.Since = state, stamp(now)
	return entry
}

func withoutLaunch(entry Entry) Entry {
	entry.LaunchedAt, entry.LaunchID = "", ""
	return entry
}

func sessionOf(context Context, shipID string) (Session, bool) {
	for _, session := range context.Observed.Sessions {
		if session.ShipID == shipID {
			return session, true
		}
	}
	return Session{}, false
}

// newVersionStep crews the ship again with a new settings version (Restart or Edit), in its folder, as a first start with a fresh restart budget; settings it cannot crew are given back while the crew is not final.
func newVersionStep(entry Entry, request Request, context Context) step {
	harness, reason := check(request.Settings, context)
	if reason != "" {
		if request.IsFinal {
			return stepOf(entry, context, false, true)
		}
		given := entry
		return step{isGivenBack: true, actions: []Action{{Kind: GiveBack, ShipID: entry.ShipID, SettingsVersion: request.SettingsVersion, Reason: reason, Entry: &given}}}
	}
	fresh := entryOf(request, harness, context.Now)
	fresh.ShipName, fresh.Folder = entry.ShipName, entry.Folder
	return step{entry: &fresh, actions: []Action{{Kind: Stop, ShipID: entry.ShipID}, {Kind: Crew, ShipID: entry.ShipID, IsResumed: true}}}
}

func stepOf(entry Entry, context Context, canStart bool, isFinal bool) step {
	switch entry.State {
	case "crewing":
		return launchStep(entry, context, isFinal)
	case "running":
		return runningStep(entry, context, canStart)
	case "restarting":
		if entry.RestartAt != "" && !context.Now.Before(parsed(entry.RestartAt)) && canStart {
			started := withState(withoutLaunch(entry), "running", context.Now)
			return step{entry: &started, actions: []Action{{Kind: Launch, ShipID: entry.ShipID}}, starts: 1}
		}
	}
	return step{}
}

// launchStep is an entry crewing: crewed (again) until its session started, then in its launch window. Activity makes it run from when its session started; none for the whole window gives the request back, or, for a final crew, is a failed start against its restart budget.
func launchStep(entry Entry, context Context, isFinal bool) step {
	launch, isSeen := context.Observed.Launches[entry.ShipID]
	if _, isRunning := sessionOf(context, entry.ShipID); entry.LaunchedAt == "" || !isRunning || !isSeen {
		return step{actions: []Action{{Kind: Crew, ShipID: entry.ShipID, IsResumed: true}}, starts: 1}
	}
	if launch.Kind == LaunchActive {
		final := withoutLaunch(entry)
		final.State, final.Since = "running", entry.LaunchedAt
		woken := wakeStep(final, context)
		woken.entry = &final
		return woken
	}
	if !isWindowOver(entry, context.Now) {
		return wakeStep(entry, context)
	}
	reason := noActivity(entry, launch)
	if isFinal {
		return exitStep(withoutLaunch(entry), context.Now, true)
	}
	given := entry
	return step{isGivenBack: true, actions: []Action{{Kind: GiveBack, ShipID: entry.ShipID, SettingsVersion: entry.SettingsVersion, Reason: reason, Entry: &given}}}
}

func isWindowOver(entry Entry, now time.Time) bool {
	return now.Sub(parsed(entry.LaunchedAt)) >= LaunchWindow
}

func noActivity(entry Entry, launch LaunchSeen) string {
	if launch.Cause != "" {
		return fmt.Sprintf("%s, %s said: %s", noActivityReason, entry.Harness, launch.Cause)
	}
	return noActivityReason
}

func runningStep(entry Entry, context Context, canStart bool) step {
	session, ok := sessionOf(context, entry.ShipID)
	if !ok {
		// No session at all, as after the machine restarts: started again, with no restart counted.
		if !canStart {
			return step{}
		}
		started := withoutLaunch(entry)
		return step{entry: &started, actions: []Action{{Kind: Launch, ShipID: entry.ShipID}}, starts: 1}
	}
	if session.Status == SessionExited {
		return exitStep(entry, context.Now, false)
	}
	if session.IsOtherVersion {
		return otherVersionStep(entry, context)
	}
	launch, isSeen := context.Observed.Launches[entry.ShipID]
	if entry.LaunchedAt == "" || !isSeen {
		return wakeStep(entry, context)
	}
	if launch.Kind == LaunchActive {
		closed := withoutLaunch(entry)
		woken := wakeStep(closed, context)
		woken.entry = &closed
		return woken
	}
	if !isWindowOver(entry, context.Now) {
		return wakeStep(entry, context)
	}
	return exitStep(entry, context.Now, true)
}

// otherVersionStep is a session another version of the trierarch started, as before an upgrade (H19): this one does not speak to it, so it is handed nothing, forced or not. Once its turn is idle it is started again, continuing its conversation, with no restart counted.
func otherVersionStep(entry Entry, context Context) step {
	if context.Observed.Ships[entry.ShipID].Turn != TurnIdle {
		return step{}
	}
	started := withoutLaunch(entry)
	return step{entry: &started, actions: []Action{{Kind: Launch, ShipID: entry.ShipID}}}
}

// wakeStep is a hand-over (#756): one message to an idle session whenever deliveries wait at the fleet or its store holds one to hand. The hand-over marks the turn busy, so the next one waits until the session is idle again. A forced message goes first, idle or busy: a busy turn is stopped for it (decision 0040).
func wakeStep(entry Entry, context Context) step {
	seen, ok := context.Observed.Ships[entry.ShipID]
	if !ok || seen.Inbox.IsLeaseEnded || seen.Turn == TurnUnknown || seen.Turn == "" {
		return step{}
	}
	if seen.Inbox.Forced > 0 {
		return step{actions: []Action{{Kind: Force, ShipID: entry.ShipID, IsTurnBusy: seen.Turn == TurnBusy}}}
	}
	if seen.Turn == TurnIdle && (seen.Inbox.Waiting > 0 || seen.IsHolding) {
		return step{actions: []Action{{Kind: Wake, ShipID: entry.ShipID}}}
	}
	return step{}
}

// exitStep is a session that exited, or failed its start: it starts again after its wait, or, with the restart budget spent, the entry is crashed. A session that failed its start still runs, so it stops first.
func exitStep(entry Entry, now time.Time, isFailedStart bool) step {
	exits := []string{}
	for _, exit := range entry.Exits {
		if now.Sub(parsed(exit)) < RestartWindow {
			exits = append(exits, exit)
		}
	}
	exits = append(exits, stamp(now))
	stop := Action{Kind: Stop, ShipID: entry.ShipID}
	if len(exits) > RestartBudget {
		crashed := withState(withoutLaunch(entry), "crashed", now)
		crashed.Exits = exits
		return step{entry: &crashed, actions: []Action{stop, {Kind: Report, ShipID: entry.ShipID, Note: crashedNote}}}
	}
	restarting := withState(withoutLaunch(entry), "restarting", now)
	restarting.Exits = exits
	restarting.RestartAt = stamp(now.Add(RestartDelays[min(len(exits), len(RestartDelays))-1]))
	actions := []Action{}
	if isFailedStart {
		actions = append(actions, stop)
	}
	actions = append(actions, Action{Kind: Report, ShipID: entry.ShipID, Note: restartingNote})
	return step{entry: &restarting, actions: actions}
}
