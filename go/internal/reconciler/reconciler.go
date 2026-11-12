// Package reconciler is the Go trierarch's Reconciler (docs/architecture.md,
// "The trierarch"): a pure function from the crew requests assigned to the
// trierarch, its saved state, what runs and the time to the actions that make
// them match, and the state those actions start from. It is the only place
// that decides; the run pass only carries the actions out. It reads no clock
// and touches nothing outside itself.
package reconciler

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/failedstarts"
)

// State is the trierarch's saved state, in the shape today's trierarch saves
// it (state.json): an entry per ship it crews, by ship id. The fields this
// trierarch does not use yet are kept as they were read.
type State struct {
	Entries map[string]Entry `json:"entries"`
	Kept    []any            `json:"kept"`
	Orphans []any            `json:"orphans"`
	Refused map[string]int   `json:"refused"`
	// KeysTold is, by harness, the state of its API key argo was told, so it is told once per state (api keys K9).
	KeysTold map[string]string `json:"keysTold,omitempty"`
	// LowResources are what the machine was low on when argo was told, so a restart while it stays low tells nothing again (#400).
	LowResources []string `json:"lowResources,omitempty"`
	// MissingPlugins are the harnesses whose aeolus-fleet plugin the last pass could not find (#1212): not offered in the report until it is back.
	MissingPlugins []string `json:"missingPlugins,omitempty"`
	// NotOffered are the harnesses the last pass found their adapters do not offer, with why (CC3, CC10), by harness.
	NotOffered []NotOfferedHarness `json:"notOffered,omitempty"`
	// PassFailure is why the last pass failed and since when; none while passes succeed.
	PassFailure *PassFailure `json:"passFailure,omitempty"`
	// FailedStarts are the machine's failed session starts since a start last succeeded; once 3 ships' starts failed in a row it stops offering itself (#853).
	FailedStarts *failedstarts.Starts `json:"failedStarts,omitempty"`
}

// NotOfferedHarness is a harness the machine does not offer now, with why.
type NotOfferedHarness struct {
	Harness string `json:"harness"`
	Reason  string `json:"reason"`
}

// PassFailure is a failing pass: the reason of the latest failure, and when the passes began to fail.
type PassFailure struct {
	Reason string `json:"reason"`
	Since  string `json:"since"`
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
	// McpServers are the names of the crew-time MCP servers its request names, which each start of its session is given (decision M3).
	McpServers []string `json:"mcpServers,omitempty"`
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
	// Login is the login its running or last session started on, apiKey or subscription (api keys K8).
	Login string `json:"login,omitempty"`
	// EarlierLogins are its earlier sessions' logins, oldest first, each kept only when a start changed it.
	EarlierLogins []EarlierLogin `json:"earlierLogins,omitempty"`
	// SentUsage is what it last sent the trierarch plugin's ship of each UTC hour of its folder's usage, by the folder's made time and the hour: each hour's ships as sent, so an hour is sent again only once they change.
	SentUsage map[string]string `json:"sentUsage,omitempty"`
	// IsIdentityGone is set once argo was told its folder holds no identity (#659, #664), until the identity is back.
	IsIdentityGone bool `json:"isIdentityGone,omitempty"`
	// IsReleasedElsewhere is set as it goes back to crewing after a release elsewhere (row 11): its worktree goes before it is crewed again (#475).
	IsReleasedElsewhere bool `json:"isReleasedElsewhere,omitempty"`
	// CrewFailures counts the crews of its settings version that failed in a row, until a crew starts its session (#827). The last of CrewFailureBudget gives the request back.
	CrewFailures int `json:"crewFailures,omitempty"`
	// ReadOnly are the paths of the ship's read-only checkouts, which its next launch reads beside its folder; made at each launch, never kept.
	ReadOnly []string `json:"-"`
}

// CrewFailureBudget is how many crews of a settings version may fail in a row before the request is given back (#827): the restart budget's count.
const CrewFailureBudget = 3

// EarlierLogin is the login of a ship's earlier session, until the start that changed it (ISO 8601).
type EarlierLogin struct {
	Login string `json:"login"`
	Until string `json:"until"`
}

// Settings are a crew request's settings as the trierarch reads them (decision 0027).
type Settings struct {
	Harness     string            `json:"harness,omitempty"`
	Workspace   Workspace         `json:"workspace"`
	Squadron    string            `json:"squadron,omitempty"`
	FirstPrompt string            `json:"firstPrompt,omitempty"`
	Options     map[string]string `json:"options,omitempty"`
	// McpServers are the names of the crew-time MCP servers the ship is crewed with (decision M3).
	McpServers []string `json:"mcpServers,omitempty"`
}

// Request is a crew request assigned to the trierarch, as the fleet answers it.
type Request struct {
	ShipID          string   `json:"shipId"`
	Settings        Settings `json:"settings"`
	SettingsVersion int      `json:"settingsVersion"`
	// Status is the crew status the fleet holds, none before the first is written.
	Status  *string `json:"status"`
	IsFinal bool    `json:"isFinal"`
	// Owner is the ship that answers for the ship, none for one without an owner.
	OwnerShipID *string `json:"ownerShipId"`
	OwnerName   *string `json:"ownerName"`
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
	// IsKeyNotReady is whether its session runs on an API key that is not ready (api keys K9).
	IsKeyNotReady bool
}

const (
	LaunchActive  = "active"
	LaunchNone    = "none"
	LaunchRefused = "refused"
)

// LaunchSeen is what a session in its launch window did, as the plugin's launch marker says: active at its first tool call, refused the model it launched with (the model it names, when it names one), or nothing yet, with the cause its harness gave.
type LaunchSeen struct {
	Kind  string
	Cause string
	Model string
}

// Observed is what the trierarch saw this pass.
type Observed struct {
	Sessions []Session
	// Launches are, by ship id, what each session in its launch window did.
	Launches map[string]LaunchSeen
	// Ships are, by ship id, what was seen of each watched session.
	Ships map[string]Seen
	// StartProblems are, by ship id, why its session cannot start on its login now, as a key not ready (api keys K9).
	StartProblems map[string]string
	// WithoutIdentity are the ships whose entry would be watched or reported for, but whose folder holds no identity (#659, #664).
	WithoutIdentity []string
	// Folders are every folder under the trierarch's root a workspace could be, whatever it is (gap rule 2).
	Folders []string
}

// ClearRequest is a pending request to the trierarch's ship that it clear the worktree it kept for a ship in a repository (decision 0032).
type ClearRequest struct {
	ShipID     string
	Repository string
}

// Context is what reconciling needs beside the state.
type Context struct {
	Requests []Request
	// Clears are the pending clear requests to the trierarch's ship.
	Clears   []ClearRequest
	Observed Observed
	Now      time.Time
	// Harnesses are the ones the configuration offers, the default first.
	Harnesses    []string
	Repositories []string
	Folders      []string
	RunningCap   int
	// Versions are each harness's version, for the harnesses whose session refused its model.
	Versions map[string]string
	// Options are, by harness, each option it offers now and its value names in order: a model a session refused is offered no more (#382).
	Options map[string]map[string][]string
	// McpServers are, by harness, the names of the MCP servers it offers now; a harness missing offers none.
	McpServers map[string][]string
	// Configuration is each offered harness as configured and detected: the flags it launches with, from which a flag still waiting on a one-time question is found.
	Configuration map[string]config.Harness
	// Trusted is, by harness, what it trusts; a harness missing trusts nothing (#381).
	Trusted map[string]Trust
	// MarksLaunches is, by harness, whether its aeolus-fleet plugin keeps launch markers (#490); a harness missing from it is in MissingPlugins.
	MarksLaunches map[string]bool
	// MissingPlugins are the harnesses whose plugin could not be found, so it is not known what it marks (#1212).
	MissingPlugins []string
	// NotOffered is, by harness, why the machine does not offer it now (CC3, CC10).
	NotOffered map[string]string
	// ConfigurationFile is the configuration as its file gives it, as the failed starts keep it: another one than the machine stopped offering itself with offers it again (#853).
	ConfigurationFile string
}

// Trust is what a harness trusts, read from its own files: the names of the repositories and folders, and the flags it still asks to accept before a session starts with them (#403).
type Trust struct {
	Repositories    []string
	Folders         []string
	UnacceptedFlags []string
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
	// ModelRefused tells argo a session refused the model it launched with (#382).
	ModelRefused ActionKind = "modelRefused"
	// IdentityGone tells argo a ship's folder holds no identity, so nothing wakes it (#659, #664).
	IdentityGone ActionKind = "identityGone"
	// Crashed tells the ship's owner its restart budget is spent (#397).
	Crashed ActionKind = "crashed"
	// RemoveStray stops what runs in a folder under the root no crewed ship uses, then removes it, whatever it is or holds (gap rule 2).
	RemoveStray ActionKind = "removeStray"
	// Clear confirms a clear request not-kept, as no worktree is kept (decision 0032).
	Clear ActionKind = "clear"
	// StoppedOffering tells argo the machine stopped offering itself after the starts of 3 ships failed in a row (#853).
	StoppedOffering ActionKind = "stoppedOffering"
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
	// Folder is the folder a remove stray removes.
	Folder string
	// Repository is what a clear names beside its ship: the repository of the ship's worktree.
	Repository string
	// ShipName, Harness, Version, Model, Exits, FailedStart and Key are what a notice names: the ship, the harness at its version and the model it refused, how often the session exited and why its last start failed, and the key that makes the notice told once.
	ShipName    string
	Harness     string
	Version     string
	Model       string
	Exits       int
	FailedStart string
	Key         string
	// FailedStarts are the failed starts a StoppedOffering tells.
	FailedStarts *failedstarts.Starts
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
	// defaultModel is what a refusal names when the session refused a model it does not name, as its harness's own default.
	defaultModel = "its default model"
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
	// outcome is how the launch window that closed in this step ended, for the machine's failed starts (#853).
	outcome *failedstarts.Outcome
}

// Reconcile answers the state the actions start from and the actions, in order.
func Reconcile(state State, context Context) (State, []Action) {
	requested := map[string]Request{}
	for _, request := range context.Requests {
		requested[request.ShipID] = request
	}
	// A refusal is kept only while its request is assigned here.
	refused := map[string]int{}
	for shipID, version := range state.Refused {
		if _, ok := requested[shipID]; ok {
			refused[shipID] = version
		}
	}
	next := State{Entries: map[string]Entry{}, Kept: state.Kept, Orphans: state.Orphans, Refused: refused, KeysTold: state.KeysTold, LowResources: state.LowResources}
	// Another configuration than the machine stopped offering itself with counts afresh, then each launch window that closed is counted in turn (#853).
	failed := failedstarts.WithConfiguration(state.FailedStarts, context.ConfigurationFile)
	isNewlyStopped := false
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
			// The entry stays in the state until its cleanup succeeded, so a pass that stops meanwhile finds its folder and token again.
			forgotten := entry
			next.Entries[shipID] = entry
			actions = append(actions, Action{Kind: Forget, ShipID: shipID, Entry: &forgotten})
			continue
		}
		if request.Status != nil && *request.Status == "releasing" {
			next.Entries[shipID] = entry
			actions = append(actions, Action{Kind: Release, ShipID: shipID})
			continue
		}
		// A harness that lost its aeolus-fleet plugin under a running session cannot crew its ship any more (#1212): the request is given back with why while its crew is not final, and the other harnesses go on.
		if reason := launchMarkerRefusal(entry.Harness, context); reason != "" && !request.IsFinal && refused[shipID] != request.SettingsVersion {
			given := entry
			next.Entries[shipID] = entry
			actions = append(actions, Action{Kind: GiveBack, ShipID: shipID, SettingsVersion: request.SettingsVersion, Reason: reason, Entry: &given})
			continue
		}
		var taken step
		if request.SettingsVersion == entry.SettingsVersion {
			taken = stepOf(entry, context, canStart(), request.IsFinal)
		} else {
			taken = newVersionStep(entry, request, state, context)
		}
		if taken.outcome != nil {
			var isNew bool
			failed, isNew = failedstarts.Count(failed, *taken.outcome, context.Now, context.ConfigurationFile)
			isNewlyStopped = isNewlyStopped || isNew
		}
		actions = append(actions, taken.actions...)
		if taken.isGivenBack {
			next.Entries[shipID] = entry
			continue
		}
		after := entry
		if taken.entry != nil {
			after = *taken.entry
		}
		after, told := identityStep(after, context.Observed)
		actions = append(actions, told...)
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
		harness, options, reason := check(request.Settings, request.ShipID, state, context)
		if reason != "" {
			// A server not offered is given back even for a final crew: the fleet refuses that, and the owner is told once (decision M4).
			if (!request.IsFinal || strings.HasPrefix(reason, mcpServersField+": ")) && refused[request.ShipID] != request.SettingsVersion {
				actions = append(actions, Action{Kind: GiveBack, ShipID: request.ShipID, SettingsVersion: request.SettingsVersion, Reason: reason})
			}
			continue
		}
		if canStart() {
			next.Entries[request.ShipID] = entryOf(request, harness, options, context.Now)
			actions = append(actions, Action{Kind: Crew, ShipID: request.ShipID})
			runningSessions++
		}
	}

	for _, session := range context.Observed.Sessions {
		if _, ok := state.Entries[session.ShipID]; !ok {
			actions = append(actions, Action{Kind: Stop, ShipID: session.ShipID})
		}
	}
	next.FailedStarts = failed
	if isNewlyStopped {
		actions = append(actions, Action{Kind: StoppedOffering, FailedStarts: failed})
	}
	// No worktree is kept and no folder under the root stays an orphan: every folder no crewed ship uses goes (gap rule 2).
	next.Kept, next.Orphans = []any{}, []any{}
	actions = append(actions, clearsOf(context.Clears)...)
	return next, append(actions, straysOf(state, next, context.Observed)...)
}

// clearsOf are the clears of the clear requests: no worktree is kept, so each is confirmed not-kept (decision 0032).
func clearsOf(clears []ClearRequest) []Action {
	actions := []Action{}
	for _, request := range clears {
		actions = append(actions, Action{Kind: Clear, ShipID: request.ShipID, Repository: request.Repository})
	}
	return actions
}

// straysOf are the removals of the folders under the root that no entry works in or holds (gap rule 2), whatever made them. A
// forgotten entry's folder is no stray: its forget removes it (gap rule 1).
func straysOf(state State, next State, observed Observed) []Action {
	inUse := []string{}
	for _, entries := range []map[string]Entry{state.Entries, next.Entries} {
		for _, entry := range entries {
			if entry.Folder != "" {
				inUse = append(inUse, entry.Folder)
			}
		}
	}
	strays := []string{}
	for _, folder := range observed.Folders {
		if !slices.ContainsFunc(inUse, func(used string) bool { return used == folder || strings.HasPrefix(used, folder+"/") }) {
			strays = append(strays, folder)
		}
	}
	actions := []Action{}
	for _, folder := range strays {
		// One under a stray goes with it.
		if !slices.ContainsFunc(strays, func(other string) bool { return strings.HasPrefix(folder, other+"/") }) {
			actions = append(actions, Action{Kind: RemoveStray, Folder: folder})
		}
	}
	return actions
}

func sortedKeys(entries map[string]Entry) []string {
	keys := make([]string, 0, len(entries))
	for key := range entries {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

// check answers the harness settings crew with and the options they pick of those it offers, or why this machine cannot crew them, naming the field at fault: the harness and the place, that no other ship crews the folder, that the harness trusts the place, each option's value, and that no flag waits on a one-time question. An option the harness does not declare is ignored: no flag, no refusal (#366).
func check(settings Settings, shipID string, state State, context Context) (string, map[string]string, string) {
	harness, reason := checkPlace(settings, shipID, state, context)
	if reason != "" {
		return "", nil, reason
	}
	offered := context.Options[harness]
	options := map[string]string{}
	for _, name := range slices.Sorted(maps.Keys(settings.Options)) {
		values, ok := offered[name]
		if !ok {
			continue
		}
		if value := settings.Options[name]; !slices.Contains(values, value) {
			return "", nil, fmt.Sprintf("options.%s: %s must be one of %s", name, name, strings.Join(values, ", "))
		}
		options[name] = settings.Options[name]
	}
	// A model the harness lists but gives no flag for would start the harness's own default model instead (#335).
	if _, err := context.Configuration[harness].LaunchFlags(options); err != nil {
		return "", nil, fmt.Sprintf("options.%s: %s gives %v", config.ModelOption, harness, err)
	}
	if reason := checkMcpServers(settings.McpServers, harness, context); reason != "" {
		return "", nil, reason
	}
	if flag := unacceptedFlag(harness, options, context); flag != "" {
		return "", nil, fmt.Sprintf("harness: %s still asks to accept %s: accept it with aeolus-trierarch init", harness, flag)
	}
	if reason := launchMarkerRefusal(harness, context); reason != "" {
		return "", nil, reason
	}
	return harness, options, ""
}

// Confirmation names a request whose harness's models are to be confirmed again, at its settings version.
type Confirmation struct {
	ShipID          string
	SettingsVersion int
	Harness         string
}

// ModelsToConfirm are the requests whose harness's models are to be confirmed again before this pass gives one back or crews it (#333): each not final, not given back at its settings version yet, not crewed at it, and picking a model its harness does not list, or offers no model for, where nothing else keeps the machine from crewing it.
func ModelsToConfirm(state State, context Context) []Confirmation {
	confirmations := []Confirmation{}
	for _, request := range context.Requests {
		if request.IsFinal || state.Refused[request.ShipID] == request.SettingsVersion {
			continue
		}
		if entry, ok := state.Entries[request.ShipID]; ok && entry.SettingsVersion == request.SettingsVersion {
			continue
		}
		model, isPicked := request.Settings.Options[config.ModelOption]
		harness, _ := checkPlace(request.Settings, request.ShipID, state, context)
		if !isPicked || slices.Contains(context.Options[harness][config.ModelOption], model) {
			continue
		}
		// Only a request the machine would crew but for its model: one it gives back for another fault waits on no probe.
		withoutModel := request.Settings
		withoutModel.Options = maps.Clone(request.Settings.Options)
		delete(withoutModel.Options, config.ModelOption)
		if _, _, reason := check(withoutModel, request.ShipID, state, context); reason != "" {
			continue
		}
		confirmations = append(confirmations, Confirmation{ShipID: request.ShipID, SettingsVersion: request.SettingsVersion, Harness: harness})
	}
	return confirmations
}

// mcpServersField is the field at fault when a named MCP server is not offered (decision M4).
const mcpServersField = "mcpServers"

// checkMcpServers is why the harness cannot be crewed with the MCP servers named, the first it does not offer, or none.
func checkMcpServers(named []string, harness string, context Context) string {
	for _, name := range named {
		if !slices.Contains(context.McpServers[harness], name) {
			return fmt.Sprintf("%s: This trierarch offers no MCP server %s to %s", mcpServersField, name, harness)
		}
	}
	return ""
}

// launchMarkerRefusal is why the harness may not start a session: the machine does not offer it (CC3, CC10), its plugin could not be found (#1212), or it is older than the launch marker (#490), so the launch window could see nothing of the session. Upgrade updates the plugin, so the reason says to run it.
func launchMarkerRefusal(harness string, context Context) string {
	if why, ok := context.NotOffered[harness]; ok {
		return fmt.Sprintf("harness: %s is not offered: %s", harness, why)
	}
	if slices.Contains(context.MissingPlugins, harness) {
		return fmt.Sprintf("harness: %s's aeolus-fleet plugin is not installed: run aeolus-trierarch upgrade", harness)
	}
	if marks, ok := context.MarksLaunches[harness]; ok && !marks {
		return fmt.Sprintf("harness: %s's aeolus-fleet plugin marks no launches: run aeolus-trierarch upgrade", harness)
	}
	return ""
}

// unacceptedFlag is the first flag the harness would launch with that it still asks to accept, or none (#403).
func unacceptedFlag(harness string, options map[string]string, context Context) string {
	unaccepted := context.Trusted[harness].UnacceptedFlags
	for _, flag := range context.Configuration[harness].EffectiveFlags(options) {
		if slices.Contains(unaccepted, flag) {
			return flag
		}
	}
	return ""
}

// checkPlace answers the harness settings crew with, or why this machine does not offer it or their workspace, another ship crews the folder already, or the harness does not trust the place.
func checkPlace(settings Settings, shipID string, state State, context Context) (string, string) {
	harness := settings.Harness
	if harness == "" && len(context.Harnesses) > 0 {
		harness = context.Harnesses[0]
	}
	if !slices.Contains(context.Harnesses, harness) {
		if settings.Harness == "" {
			return "", "harness: This trierarch offers no harness"
		}
		return "", fmt.Sprintf("harness: This trierarch offers no harness %s", harness)
	}
	trust := context.Trusted[harness]
	switch settings.Workspace.Kind {
	case "worktree":
		name := settings.Workspace.Repository
		if !slices.Contains(context.Repositories, name) {
			return "", fmt.Sprintf("workspace.repository: This trierarch offers no repository %s", name)
		}
		if !slices.Contains(trust.Repositories, name) {
			return "", fmt.Sprintf("workspace.repository: %s does not trust the repository %s: add it with aeolus-trierarch init, which trusts it", harness, name)
		}
	case "folder":
		name := settings.Workspace.Name
		if !slices.Contains(context.Folders, name) {
			return "", fmt.Sprintf("workspace.name: This trierarch offers no folder %s", name)
		}
		for _, other := range sortedKeys(state.Entries) {
			if entry := state.Entries[other]; other != shipID && entry.Workspace.Kind == "folder" && entry.Workspace.Name == name {
				return "", fmt.Sprintf("workspace.name: The folder %s crews %s already: one folder crews one ship", name, other)
			}
		}
		if !slices.Contains(trust.Folders, name) {
			return "", fmt.Sprintf("workspace.name: %s does not trust the folder %s: add it with aeolus-trierarch init, which trusts it", harness, name)
		}
	default:
		return "", fmt.Sprintf("workspace.kind: %s is no workspace", settings.Workspace.Kind)
	}
	return harness, ""
}

func entryOf(request Request, harness string, options map[string]string, now time.Time) Entry {
	return Entry{
		ShipID:          request.ShipID,
		SettingsVersion: request.SettingsVersion,
		Harness:         harness,
		Workspace:       request.Settings.Workspace,
		Squadron:        request.Settings.Squadron,
		FirstPrompt:     request.Settings.FirstPrompt,
		Options:         options,
		McpServers:      request.Settings.McpServers,
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
func newVersionStep(entry Entry, request Request, state State, context Context) step {
	harness, options, reason := check(request.Settings, request.ShipID, state, context)
	if reason != "" {
		if request.IsFinal {
			return stepOf(entry, context, false, true)
		}
		given := entry
		return step{isGivenBack: true, actions: []Action{{Kind: GiveBack, ShipID: entry.ShipID, SettingsVersion: request.SettingsVersion, Reason: reason, Entry: &given}}}
	}
	fresh := entryOf(request, harness, options, context.Now)
	fresh.ShipName, fresh.Folder = entry.ShipName, entry.Folder
	return step{entry: &fresh, actions: []Action{{Kind: Stop, ShipID: entry.ShipID}, {Kind: Crew, ShipID: entry.ShipID, IsResumed: true}}}
}

func stepOf(entry Entry, context Context, canStart bool, isFinal bool) step {
	if seen, ok := context.Observed.Ships[entry.ShipID]; ok && seen.Inbox.IsLeaseEnded {
		// Released elsewhere (row 11): its session stops and the ship is crewed again, in a fresh worktree as a first start, with its first prompt and no resume (#475). A final crew stays final in the fleet (#469).
		again := withState(entry, "crewing", context.Now)
		again.IsReleasedElsewhere, again.HasStarted = true, false
		return step{entry: &again, actions: []Action{{Kind: Stop, ShipID: entry.ShipID}, {Kind: Crew, ShipID: entry.ShipID}}}
	}
	switch entry.State {
	case "crewing":
		return launchStep(entry, context, isFinal)
	case "running":
		return runningStep(entry, context, canStart)
	case "restarting":
		if entry.RestartAt != "" && !context.Now.Before(parsed(entry.RestartAt)) && canStart && context.Observed.StartProblems[entry.ShipID] == "" {
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
		woken.outcome = &failedstarts.Outcome{ShipID: entry.ShipID, IsSuccess: true}
		return woken
	}
	if launch.Kind == LaunchRefused {
		refused := modelRefusal(entry, launch.Model, context.Versions)
		return failedLaunch(entry, context.Now, refused, isFinal)
	}
	if !isWindowOver(entry, context.Now) {
		return wakeStep(entry, context)
	}
	return failedLaunch(entry, context.Now, refusal{reason: noActivity(entry, launch)}, isFinal)
}

// failedLaunch is a launch window that ended without activity, or with the model refused: the request is given back with the reason while its crew is not final, with what the refusal tells first; for a final crew it is a failed start against the restart budget.
func failedLaunch(entry Entry, now time.Time, why refusal, isFinal bool) step {
	outcome := machineFailedStart(entry, why)
	if isFinal {
		failed := exitStep(withoutLaunch(entry), now, why.reason)
		failed.actions = append(append([]Action{}, why.actions...), failed.actions...)
		failed.outcome = outcome
		return failed
	}
	given := entry
	return step{outcome: outcome, isGivenBack: true, actions: append(append([]Action{}, why.actions...), Action{Kind: GiveBack, ShipID: entry.ShipID, SettingsVersion: entry.SettingsVersion, Reason: why.reason, Entry: &given})}
}

// refusal is why a launch failed, with the notice a refused model tells argo.
type refusal struct {
	reason  string
	actions []Action
	// isModelRefused is whether the session refused the model it launched with.
	isModelRefused bool
}

// machineFailedStart is a failed start counted against the machine (#853): any but a refusal of a model the settings picked, which is the settings' cause, kept refused on its own (#382).
func machineFailedStart(entry Entry, why refusal) *failedstarts.Outcome {
	if _, isPicked := entry.Options[modelOption]; why.isModelRefused && isPicked {
		return nil
	}
	return &failedstarts.Outcome{ShipID: entry.ShipID, Reason: why.reason}
}

// modelOption is the option that names the model a session launches with.
const modelOption = "model"

// modelRefusal is why a session refused the model it launched with, naming the harness and its version. Argo is told only when the settings picked the model and the refusal names it, at a version known (#382).
func modelRefusal(entry Entry, model string, versions map[string]string) refusal {
	version := versions[entry.Harness]
	named := model
	if named == "" {
		named = defaultModel
	}
	reason := entry.Harness
	if version != "" {
		reason += " " + version
	}
	reason += " refused " + named
	if _, isPicked := entry.Options[modelOption]; !isPicked || version == "" || model == "" {
		return refusal{reason: reason, isModelRefused: true}
	}
	return refusal{reason: reason, isModelRefused: true, actions: []Action{{Kind: ModelRefused, ShipID: entry.ShipID, ShipName: entry.ShipName, Harness: entry.Harness, Version: version, Model: model}}}
}

// identityStep is an entry running, restarting or crashed whose folder holds no identity (#659, #664), as when its harness's plugin was uninstalled: its inbox cannot be seen and no report goes on its behalf, so it is woken no more. Argo is told once per loss, whatever state it moves between; once the identity is back, a later loss is told again.
func identityStep(entry Entry, observed Observed) (Entry, []Action) {
	isGone := slices.Contains(written, entry.State) && slices.Contains(observed.WithoutIdentity, entry.ShipID)
	switch {
	case isGone && !entry.IsIdentityGone:
		entry.IsIdentityGone = true
		return entry, []Action{{Kind: IdentityGone, ShipID: entry.ShipID, ShipName: entry.ShipName}}
	case !isGone && entry.IsIdentityGone:
		entry.IsIdentityGone = false
	}
	return entry, nil
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
	if !ok && context.Observed.StartProblems[entry.ShipID] != "" {
		// Its login cannot start it now (api keys K9): it waits, restarting, until it can, with no restart counted.
		waiting := withState(withoutLaunch(entry), "restarting", context.Now)
		waiting.RestartAt = stamp(context.Now)
		return step{entry: &waiting}
	}
	if !ok {
		// No session at all, as after the machine restarts: started again, with no restart counted.
		if !canStart {
			return step{}
		}
		started := withoutLaunch(entry)
		return step{entry: &started, actions: []Action{{Kind: Launch, ShipID: entry.ShipID}}, starts: 1}
	}
	if session.Status == SessionExited {
		return exitStep(entry, context.Now, "")
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
		woken.outcome = &failedstarts.Outcome{ShipID: entry.ShipID, IsSuccess: true}
		return woken
	}
	if launch.Kind == LaunchRefused {
		return failedLaunch(entry, context.Now, modelRefusal(entry, launch.Model, context.Versions), true)
	}
	if !isWindowOver(entry, context.Now) {
		return wakeStep(entry, context)
	}
	quiet := exitStep(entry, context.Now, noActivity(entry, launch))
	quiet.outcome = &failedstarts.Outcome{ShipID: entry.ShipID, Reason: noActivity(entry, launch)}
	return quiet
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
	if !ok || seen.Inbox.IsLeaseEnded || seen.Turn == TurnUnknown || seen.Turn == "" || seen.IsKeyNotReady {
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

// exitStep is a session that exited, or failed its start with the reason given: it starts again after its wait, or, with the restart budget spent, the entry is crashed and its owner told, with why its last start failed when it did. A session that failed its start still runs, so it stops first.
func exitStep(entry Entry, now time.Time, failedStart string) step {
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
		told := Action{Kind: Crashed, ShipID: entry.ShipID, ShipName: entry.ShipName, Exits: len(exits), FailedStart: failedStart, Key: "trierarch:crashed:" + entry.ShipID + ":" + now.UTC().Format("2006-01-02T15:04:05.000Z")}
		return step{entry: &crashed, actions: []Action{stop, {Kind: Report, ShipID: entry.ShipID, Note: crashedNote}, told}}
	}
	restarting := withState(withoutLaunch(entry), "restarting", now)
	restarting.Exits = exits
	restarting.RestartAt = stamp(now.Add(RestartDelays[min(len(exits), len(RestartDelays))-1]))
	actions := []Action{}
	if failedStart != "" {
		actions = append(actions, stop)
	}
	actions = append(actions, Action{Kind: Report, ShipID: entry.ShipID, Note: restartingNote})
	return step{entry: &restarting, actions: actions}
}
