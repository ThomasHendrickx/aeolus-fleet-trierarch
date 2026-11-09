// Package codex is Codex as a harness (docs/architecture.md, "First
// adapters"), headless on the host: its sessions, one `codex exec` per turn
// under each ship's hold, and its one-time questions answered ahead through
// its own app server. The identity and the turn marker go through the
// aeolus-fleet plugin for Codex, in Codex's own plugin data folder, whose hooks
// run in `codex exec` as in a terminal. The plugin's new or changed hooks are
// trusted before every launch: a plugin update changes them, and Codex runs
// none it does not trust (#581).
package codex

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
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

// Hooks trusts the aeolus-fleet plugin's new or changed hooks, as Codex sees them from the folder, and answers their keys.
type Hooks interface {
	TrustAeolusHooks(folder string) ([]string, error)
}

// Configuration reads what Codex's configuration names for a folder, with a launch's configuration flags over it: the user's and the project's MCP servers and the plugins it enables.
type Configuration interface {
	ConfiguredFor(folder string, overrides []string) (Configured, error)
}

// launchVariable is the variable a session's launch id is passed in, for the plugin's hooks to mark that launch (#490).
const launchVariable = "AEOLUS_LAUNCH"

const (
	// provider is the model provider a session on an API key uses: the model proxy (api keys K6).
	provider = "aeolus"
	// proxyTokenVariable is the variable the provider reads its token from, which the hold sets from the session's own file.
	proxyTokenVariable = "AEOLUS_MODEL_TOKEN"
	// mcpTokenVariable is the variable each crew-time MCP server reads the session's bearer token at the MCP proxy from, a secret variable of its hold.
	mcpTokenVariable = "AEOLUS_MCP_TOKEN"
)

// Harness is Codex as the run pass starts and watches its sessions, each under its hold; the identity, turn and store through the aeolus-fleet plugin Codex installed.
type Harness struct {
	plugin.Plugin
	Runtime Runtime
	// Settings are Codex's settings as the machine offers them now, read at each launch: detection confirms its models again while the trierarch runs (#333, #335).
	Settings func() config.Harness
	Hooks    Hooks
	// Configuration is what Codex's configuration names for a folder, each server and plugin of it turned off but the aeolus-fleet plugin (#329).
	Configuration Configuration
	// Events is where the ship's hold keeps every line its session wrote.
	Events func(shipID string) string
	// ProxyURL is where sessions on an API key reach the model proxy (headless H16); false before it first listened.
	ProxyURL func() (string, bool)
}

// routeOf is how a session on the login reaches its model (api keys K6): on an API key, the model proxy as a provider of its own, set on the command line (a project's config cannot set one), its token in the variable the provider names and fresh for each start; on its subscription nothing, so it signs in as Codex does. Every later turn's exec keeps the flags, and the hold keeps the variable.
func (h Harness) routeOf(login string) ([]string, *sessions.ProxyToken, error) {
	if login != "apiKey" {
		return nil, nil, nil
	}
	address, ok := "", false
	if h.ProxyURL != nil {
		address, ok = h.ProxyURL()
	}
	if !ok {
		return nil, nil, errors.New("the model proxy is not running yet")
	}
	settings := [][2]string{
		{"name", `"Aeolus model proxy"`},
		{"base_url", `"` + address + `/openai/v1"`},
		{"env_key", `"` + proxyTokenVariable + `"`},
		{"wire_api", `"responses"`},
	}
	flags := []string{}
	for _, setting := range settings {
		flags = append(flags, "-c", "model_providers."+provider+"."+setting[0]+"="+setting[1])
	}
	flags = append(flags, "-c", `model_provider="`+provider+`"`)
	return flags, &sessions.ProxyToken{Harness: "codex", Variable: proxyTokenVariable, Token: proxytoken.New()}, nil
}

// CanAddMcpServer is whether a session can be started with the server: Codex's -c takes its key's path apart at every dot, quoted or not, so a server whose name holds one cannot be named there, and replacing the whole mcp_servers table would drop the user's own servers.
func CanAddMcpServer(name string) bool { return !strings.Contains(name, ".") }

// othersOff turns off, for this session only, every MCP server Codex's configuration names for the entry's folder, and every plugin it enables but the aeolus-fleet plugin, since a plugin may bring servers of its own and no listing that reaches none names them (#329): one -c each, with each name as a quoted key, which Codex merges into its table, so the user's config.toml is left as it is and a name holding a dot is turned off too; nothing for what it names none of. A server named as a crewed one is an error: -c merges into its entry, so Codex would refuse it or carry its fields into the proxy's.
func (h Harness) othersOff(entry reconciler.Entry, flags []string) ([]string, error) {
	overrides, err := overridesOf(flags)
	if err != nil {
		return nil, err
	}
	configured, err := h.Configuration.ConfiguredFor(entry.Folder, overrides)
	if err != nil {
		return nil, err
	}
	for _, name := range configured.McpServers {
		if slices.Contains(entry.McpServers, name) {
			return nil, fmt.Errorf("codex's configuration for %s names its own MCP server %s: -c would merge into it, so the session cannot be started with the crewed %s alone", entry.Folder, name, name)
		}
	}
	servers, err := disabledOf("mcp_servers", configured.McpServers)
	if err != nil {
		return nil, err
	}
	plugins, err := disabledOf("plugins", slices.DeleteFunc(slices.Clone(configured.Plugins), isTrierarchsPlugin))
	if err != nil {
		return nil, err
	}
	return append(servers, plugins...), nil
}

// overridesOf are the launch flags that change Codex's configuration, in order, for config/read to read it as the session will: each -c, --enable and --disable, and --strict-config. A profile, whose own file may name servers, or another folder, whose project configuration may, is an error: config/read takes neither, so the session could get a server it does not turn off.
func overridesOf(flags []string) ([]string, error) {
	var overrides []string
	for at := 0; at < len(flags); at++ {
		flag := flags[at]
		switch {
		case flag == "-c" || flag == "--config" || flag == "--enable" || flag == "--disable":
			overrides = append(overrides, flags[at:min(at+2, len(flags))]...)
			at++
		case flag == "--strict-config" || strings.HasPrefix(flag, "-c") || strings.HasPrefix(flag, "--config=") || strings.HasPrefix(flag, "--enable=") || strings.HasPrefix(flag, "--disable="):
			overrides = append(overrides, flag)
		case strings.HasPrefix(flag, "-p") || flag == "--profile" || strings.HasPrefix(flag, "--profile=") || strings.HasPrefix(flag, "-C") || flag == "--cd" || strings.HasPrefix(flag, "--cd="):
			return nil, fmt.Errorf("codex's flag %s picks a configuration the trierarch cannot read before the start, so the session could get MCP servers its crew request does not name", flag)
		}
	}
	return overrides, nil
}

// disabledOf is `-c <key>={"<name>"={enabled=false},...}` for the names, in order; nothing for none.
func disabledOf(key string, names []string) ([]string, error) {
	if len(names) == 0 {
		return nil, nil
	}
	// Codex's configuration keeps its order of its own.
	names = slices.Sorted(slices.Values(names))
	entries := make([]string, 0, len(names))
	for _, name := range names {
		// A JSON string is a TOML basic string.
		quoted, err := json.Marshal(name)
		if err != nil {
			return nil, err
		}
		entries = append(entries, string(quoted)+"={enabled=false}")
	}
	return []string{"-c", key + "={" + strings.Join(entries, ",") + "}"}, nil
}

// mcpOf is how a session reaches the crew-time MCP servers its entry names (decisions M6, M7), and no other: every one Codex's configuration names turned off, and each named one at the MCP proxy as a streamable HTTP server of its own on the command line, its bearer token read from a secret variable of the hold, a token of the session's own, fresh for each start, so the command line never holds it; no server of its own for an entry that names none. Every later turn's exec keeps the flags, and the hold keeps the variable.
func (h Harness) mcpOf(entry reconciler.Entry, launchFlags []string) ([]string, *sessions.Mcp, error) {
	off, err := h.othersOff(entry, launchFlags)
	if err != nil {
		return nil, nil, err
	}
	if len(entry.McpServers) == 0 {
		return off, nil, nil
	}
	address, ok := "", false
	if h.ProxyURL != nil {
		address, ok = h.ProxyURL()
	}
	if !ok {
		return nil, nil, errors.New("the MCP proxy is not running yet")
	}
	flags := off
	for _, name := range entry.McpServers {
		flags = append(flags, "-c", "mcp_servers."+name+`={url="`+address+mcpproxy.PathOf(entry.ShipID, name)+`",bearer_token_env_var="`+mcpTokenVariable+`"}`)
	}
	return flags, &sessions.Mcp{Access: mcpproxy.Access{Token: proxytoken.New(), Servers: entry.McpServers}}, nil
}

// Launch starts the entry's session in its folder, on the login it is to start on: its first turn with its first prompt on a first start, else the wake on the folder's last conversation.
func (h Harness) Launch(entry reconciler.Entry, isFirstStart bool, launchID string) error {
	route, token, err := h.routeOf(entry.Login)
	if err != nil {
		return err
	}
	flags := append(h.Settings().EffectiveFlags(entry.Options), route...)
	servers, mcp, err := h.mcpOf(entry, flags)
	if err != nil {
		return err
	}
	line := prompt.Wake(WakeCommand)
	if isFirstStart && entry.FirstPrompt != "" {
		line = prompt.First(entry.FirstPrompt)
	}
	command := CommandLine(append(flags, servers...), line, isFirstStart)
	if _, err := h.Hooks.TrustAeolusHooks(entry.Folder); err != nil {
		return err
	}
	if err := h.ClearLaunch(entry.Folder); err != nil {
		return err
	}
	start := sessions.Start{ShipID: entry.ShipID, Folder: entry.Folder, Harness: "codex", Command: command, Env: map[string]string{launchVariable: launchID}, ProxyToken: token, Mcp: mcp}
	if mcp != nil {
		start.SecretEnv = map[string]string{mcpTokenVariable: mcp.Access.Token}
	}
	return h.Runtime.Start(start)
}

// LaunchSeen is what the session did in its launch window, as its marker says; with no activity, the cause Codex's last error event gives (H13).
func (h Harness) LaunchSeen(entry reconciler.Entry) reconciler.LaunchSeen {
	seen := h.Plugin.LaunchSeen(entry.Folder, entry.LaunchID)
	if seen.IsRefused {
		return reconciler.LaunchSeen{Kind: reconciler.LaunchRefused, Model: seen.RefusedModel}
	}
	if seen.IsActive {
		return reconciler.LaunchSeen{Kind: reconciler.LaunchActive}
	}
	return reconciler.LaunchSeen{Kind: reconciler.LaunchNone, Cause: ErrorIn(h.Events(entry.ShipID))}
}

// HandOver hands one message over to the entry's idle session (#756): the plugin's line, as a wake, is the prompt of a turn of its own; false when nothing is handed.
func (h Harness) HandOver(entry reconciler.Entry) (bool, error) {
	line, ok := h.HandOverLine(entry.Folder)
	if !ok {
		return false, nil
	}
	return true, h.Runtime.Send(entry.ShipID, prompt.Wake(line))
}

// ForceOver hands a forced message over (decision 0040), its busy turn stopped first; false when nothing is handed.
func (h Harness) ForceOver(entry reconciler.Entry, isTurnBusy bool) (bool, error) {
	line, ok := h.ForceOverLine(entry.Folder)
	if !ok {
		return false, nil
	}
	if isTurnBusy {
		if err := h.Runtime.Interrupt(entry.ShipID); err != nil {
			return false, err
		}
	}
	return true, h.Runtime.Send(entry.ShipID, prompt.Wake(line))
}

// Problem is why no Codex session can start on this machine now: its plugin's scripts gone (#827).
func (h Harness) Problem() error { return h.IsInstalled() }

func (h Harness) WriteIdentity(entry reconciler.Entry, identity plugin.Identity, crewToken string) error {
	return h.Plugin.WriteIdentity(entry.Folder, identity, crewToken)
}

func (h Harness) HasIdentity(entry reconciler.Entry) bool { return h.Plugin.HasIdentity(entry.Folder) }

func (h Harness) DeleteIdentity(entry reconciler.Entry) error {
	return h.Plugin.DeleteIdentity(entry.Folder)
}

func (h Harness) SessionDied(entry reconciler.Entry) error { return h.Plugin.SessionDied(entry.Folder) }

func (h Harness) Turn(entry reconciler.Entry) string { return h.Plugin.Turn(entry.Folder) }

func (h Harness) IsHolding(entry reconciler.Entry) bool { return h.Plugin.IsHolding(entry.Folder) }

// NotOfferedReason is none: the machine offers it once its plugin is found.
func (h Harness) NotOfferedReason() string { return "" }
