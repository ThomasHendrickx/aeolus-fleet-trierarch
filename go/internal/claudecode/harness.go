package claudecode

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/prompt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/proxytoken"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

// Runtime is the session runtime as a harness uses it: start a session, send it a line, stop its turn.
type Runtime interface {
	Start(session sessions.Start) error
	Send(shipID string, line string) error
	Interrupt(shipID string) error
}

// Onboarding is Claude Code's onboarding, completed before every launch, so a session stops at no first-run screen (#403).
type Onboarding interface {
	CompleteOnboarding() error
}

// launchVariable is the variable a session's launch id is passed in, for the plugin's hooks to mark that launch (#490).
const launchVariable = "AEOLUS_LAUNCH"

// Harness is Claude Code as the run pass starts and watches its sessions, on the host, each under its hold; its sessions' identities through the aeolus-fleet plugin.
type Harness struct {
	Plugin   plugin.Plugin
	Runtime  Runtime
	Settings config.Harness
	// Projects is Claude Code's projects folder, where it keeps each folder's conversations.
	Projects   string
	Onboarding Onboarding
	// Managed is the folder Claude Code reads its managed settings from, User its user settings file: where a plan default mode is read from (#505).
	Managed string
	User    string
	// PermissionModes are the modes the installed Claude Code lists, as detection last found them; nil before it found any (#517).
	PermissionModes func() []string
	// Events is where the ship's hold keeps every line its session wrote.
	Events func(shipID string) string
	// ProxyURL is where sessions on an API key reach the model proxy (headless H16); false before it first listened.
	ProxyURL func() (string, bool)
	// Sessions is the sessions folder, where each session's MCP configuration is kept in its folder.
	Sessions string
	// Homes is where each ship has a home of its own, for sessions in containers, which its container gets as its home (decision 0039); empty on the host, where every session shares the user's.
	Homes string
}

// homeOf is the ship's own home, which holds its identity and Claude Code's files and nothing of another ship.
func (h Harness) homeOf(entry reconciler.Entry) string { return filepath.Join(h.Homes, entry.ShipID) }

// pluginOf is the plugin as the entry's session finds its files: in its ship's home in a container, where the image's plugin of the same version finds the identity the host's scripts wrote.
func (h Harness) pluginOf(entry reconciler.Entry) plugin.Plugin {
	if h.Homes == "" {
		return h.Plugin
	}
	home := h.homeOf(entry)
	return plugin.Plugin{Root: h.Plugin.Root, Data: filepath.Join(home, ".claude", "plugins", "data", plugin.DataFolder), Crews: filepath.Join(home, ".aeolus", "crews", "claude-code")}
}

// projectsOf is the projects folder the entry's session keeps its conversations in.
func (h Harness) projectsOf(entry reconciler.Entry) string {
	if h.Homes == "" {
		return h.Projects
	}
	return Projects(h.homeOf(entry), "")
}

// userOf is the user settings file the entry's session reads.
func (h Harness) userOf(entry reconciler.Entry) string {
	if h.Homes == "" {
		return h.User
	}
	return UserSettings(h.homeOf(entry), "")
}

// privateFolderMode is a ship's home's mode: only its owner reads it, as it holds the ship's crew token.
const privateFolderMode = 0o700

// prepare answers Claude Code's one-time questions before a launch, a restart too, so the session asks nothing (#403): on the host the user's onboarding; in a container the ship's home, made for its owner alone, with its onboarding completed, the folder trusted at its path, which the container mounts at the same path, and bypass permissions mode accepted only where the operator accepted it on the host.
func (h Harness) prepare(entry reconciler.Entry) error {
	if h.Homes == "" {
		return h.Onboarding.CompleteOnboarding()
	}
	home := h.homeOf(entry)
	if err := os.MkdirAll(home, privateFolderMode); err != nil {
		return err
	}
	setup := Of(home, "")
	if err := setup.CompleteOnboarding(); err != nil {
		return err
	}
	if err := setup.Trust(entry.Folder); err != nil {
		return err
	}
	if IsSkipPermissionsAccepted(h.User) {
		return AcceptSkipPermissions(h.userOf(entry))
	}
	return nil
}

// routeOf is how a session on the login reaches its model: on an API key, the proxy's address and a token of the session's own, fresh for each start, which its hold hands it; on its subscription, nothing.
func (h Harness) routeOf(login string) (map[string]string, *sessions.ProxyToken, error) {
	if login != "apiKey" {
		return map[string]string{}, nil, nil
	}
	address, ok := "", false
	if h.ProxyURL != nil {
		address, ok = h.ProxyURL()
	}
	if !ok {
		return nil, nil, errors.New("the model proxy is not running yet")
	}
	return map[string]string{"ANTHROPIC_BASE_URL": address + "/anthropic"}, &sessions.ProxyToken{Harness: "claude-code", Variable: "ANTHROPIC_AUTH_TOKEN", Token: proxytoken.New()}, nil
}

// mcpOf is how a session reaches the crew-time MCP servers its entry names (decisions M6, M7): each at the MCP proxy with a token of its own, fresh for each start, in an MCP configuration kept in the session's folder, which the command line names by its path alone; nothing for an entry that names none. A container sees that one file read-only at the same path, never the folder it is in, so a session cannot plant a link the trierarch would write through.
func (h Harness) mcpOf(entry reconciler.Entry) ([]string, *sessions.Mcp, error) {
	if len(entry.McpServers) == 0 {
		return nil, nil, nil
	}
	address, ok := "", false
	if h.ProxyURL != nil {
		address, ok = h.ProxyURL()
	}
	if !ok {
		return nil, nil, errors.New("the MCP proxy is not running yet")
	}
	token := proxytoken.New()
	type server struct {
		Type    string            `json:"type"`
		URL     string            `json:"url"`
		Headers map[string]string `json:"headers"`
	}
	servers := map[string]server{}
	for _, name := range entry.McpServers {
		servers[name] = server{Type: "http", URL: address + mcpproxy.PathOf(entry.ShipID, name), Headers: map[string]string{"Authorization": "Bearer " + token}}
	}
	config, err := json.Marshal(map[string]any{"mcpServers": servers})
	if err != nil {
		return nil, nil, err
	}
	return []string{"--mcp-config", hold.FilesOf(h.Sessions, entry.ShipID).McpConfig}, &sessions.Mcp{Access: mcpproxy.Access{Token: token, Servers: entry.McpServers}, Config: config}, nil
}

// Launch starts the entry's session in its folder, on the login it is to start on: its first prompt on a first start, the wake otherwise, continuing the folder's conversation when Claude Code keeps one.
func (h Harness) Launch(entry reconciler.Entry, isFirstStart bool, launchID string) error {
	env, token, err := h.routeOf(entry.Login)
	if err != nil {
		return err
	}
	mcpFlags, mcp, err := h.mcpOf(entry)
	if err != nil {
		return err
	}
	if err := h.prepare(entry); err != nil {
		return err
	}
	line := WakePrompt()
	if isFirstStart && entry.FirstPrompt != "" {
		line = prompt.First(entry.FirstPrompt)
	}
	flags := h.Settings.EffectiveFlags(entry.Options)
	var modes []string
	if h.PermissionModes != nil {
		modes = h.PermissionModes()
	}
	override := PlanOverride(flags, DefaultModeOf(h.Managed, h.userOf(entry), flags, entry.Folder), modes)
	// --mcp-config takes every word up to the next flag, so it comes last.
	command := append(CommandLine(flags, override, !isFirstStart && HasConversation(h.projectsOf(entry), entry.Folder), entry.ReadOnly), mcpFlags...)
	if err := h.pluginOf(entry).ClearLaunch(entry.Folder); err != nil {
		return err
	}
	env[launchVariable] = launchID
	if err := h.Runtime.Start(sessions.Start{ShipID: entry.ShipID, Folder: entry.Folder, Harness: "claude-code", Command: command, Env: env, ProxyToken: token, ReadOnly: entry.ReadOnly, Mcp: mcp}); err != nil {
		return err
	}
	return h.Runtime.Send(entry.ShipID, UserLine(line))
}

// LaunchSeen is what the session did in its launch window, as its marker says; with no activity, the cause its last error event gives (H13).
func (h Harness) LaunchSeen(entry reconciler.Entry) reconciler.LaunchSeen {
	seen := h.pluginOf(entry).LaunchSeen(entry.Folder, entry.LaunchID)
	if seen.IsRefused {
		return reconciler.LaunchSeen{Kind: reconciler.LaunchRefused, Model: seen.RefusedModel}
	}
	if seen.IsActive {
		return reconciler.LaunchSeen{Kind: reconciler.LaunchActive}
	}
	return reconciler.LaunchSeen{Kind: reconciler.LaunchNone, Cause: errorIn(h.Events(entry.ShipID))}
}

// errorIn is why Claude Code's last error event says it failed: the last result that is an error; empty without one.
func errorIn(events string) string {
	file, err := os.Open(events)
	if err != nil {
		return ""
	}
	defer file.Close()
	cause := ""
	lines := bufio.NewScanner(file)
	lines.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for lines.Scan() {
		var event struct {
			Type    string `json:"type"`
			IsError bool   `json:"is_error"`
			Result  any    `json:"result"`
			Subtype string `json:"subtype"`
		}
		if json.Unmarshal([]byte(lines.Text()), &event) != nil || event.Type != "result" || !event.IsError {
			continue
		}
		if result, ok := event.Result.(string); ok && strings.TrimSpace(result) != "" {
			cause = result
		} else if event.Subtype != "" {
			cause = event.Subtype
		} else {
			cause = "an error"
		}
	}
	return cause
}

func (h Harness) WriteIdentity(entry reconciler.Entry, identity plugin.Identity, crewToken string) error {
	return h.pluginOf(entry).WriteIdentity(entry.Folder, identity, crewToken)
}

func (h Harness) HasIdentity(entry reconciler.Entry) bool {
	return h.pluginOf(entry).HasIdentity(entry.Folder)
}

// DeleteIdentity deletes the session's identity, and in a container its ship's home with it, as on a release.
func (h Harness) DeleteIdentity(entry reconciler.Entry) error {
	if err := h.pluginOf(entry).DeleteIdentity(entry.Folder); err != nil {
		return err
	}
	if h.Homes == "" {
		return nil
	}
	return os.RemoveAll(h.homeOf(entry))
}

func (h Harness) SessionDied(entry reconciler.Entry) error {
	return h.pluginOf(entry).SessionDied(entry.Folder)
}

func (h Harness) Turn(entry reconciler.Entry) string { return h.pluginOf(entry).Turn(entry.Folder) }

func (h Harness) IsHolding(entry reconciler.Entry) bool {
	return h.pluginOf(entry).IsHolding(entry.Folder)
}

// HandOver hands one message over to the entry's idle session (#756): the plugin's line, typed in as a wake; false when nothing is handed.
func (h Harness) HandOver(entry reconciler.Entry) (bool, error) {
	line, ok := h.pluginOf(entry).HandOverLine(entry.Folder)
	if !ok {
		return false, nil
	}
	return true, h.Runtime.Send(entry.ShipID, UserLine(prompt.Wake(line)))
}

// ForceOver hands a forced message over (decision 0040), its busy turn stopped first; false when nothing is handed.
func (h Harness) ForceOver(entry reconciler.Entry, isTurnBusy bool) (bool, error) {
	line, ok := h.pluginOf(entry).ForceOverLine(entry.Folder)
	if !ok {
		return false, nil
	}
	if isTurnBusy {
		if err := h.Runtime.Interrupt(entry.ShipID); err != nil {
			return false, err
		}
	}
	return true, h.Runtime.Send(entry.ShipID, UserLine(prompt.Wake(line)))
}

func (h Harness) Problem() error { return h.Plugin.IsInstalled() }

// NotOfferedReason is none: the machine offers it once its plugin is found.
func (h Harness) NotOfferedReason() string { return "" }

// MarksLaunches is whether the aeolus-fleet plugin keeps launch markers (#490).
func (h Harness) MarksLaunches() (bool, error) { return h.Plugin.MarksLaunches() }
