package claudecode

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
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

// Launch starts the entry's session in its folder, on the login it is to start on: its first prompt on a first start, the wake otherwise, continuing the folder's conversation when Claude Code keeps one.
func (h Harness) Launch(entry reconciler.Entry, isFirstStart bool, launchID string) error {
	env, token, err := h.routeOf(entry.Login)
	if err != nil {
		return err
	}
	if err := h.Onboarding.CompleteOnboarding(); err != nil {
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
	override := PlanOverride(flags, DefaultModeOf(h.Managed, h.User, flags, entry.Folder), modes)
	command := CommandLine(flags, override, !isFirstStart && HasConversation(h.Projects, entry.Folder), entry.ReadOnly)
	if err := h.Plugin.ClearLaunch(entry.Folder); err != nil {
		return err
	}
	env[launchVariable] = launchID
	if err := h.Runtime.Start(sessions.Start{ShipID: entry.ShipID, Folder: entry.Folder, Harness: "claude-code", Command: command, Env: env, ProxyToken: token}); err != nil {
		return err
	}
	return h.Runtime.Send(entry.ShipID, UserLine(line))
}

// LaunchSeen is what the session did in its launch window, as its marker says; with no activity, the cause its last error event gives (H13).
func (h Harness) LaunchSeen(entry reconciler.Entry) reconciler.LaunchSeen {
	seen := h.Plugin.LaunchSeen(entry.Folder, entry.LaunchID)
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

func (h Harness) WriteIdentity(folder string, identity plugin.Identity, crewToken string) error {
	return h.Plugin.WriteIdentity(folder, identity, crewToken)
}

func (h Harness) HasIdentity(folder string) bool { return h.Plugin.HasIdentity(folder) }

func (h Harness) DeleteIdentity(folder string) error { return h.Plugin.DeleteIdentity(folder) }

func (h Harness) SessionDied(folder string) error { return h.Plugin.SessionDied(folder) }

func (h Harness) Turn(folder string) string { return h.Plugin.Turn(folder) }

func (h Harness) IsHolding(folder string) bool { return h.Plugin.IsHolding(folder) }

// HandOver hands one message over to the entry's idle session (#756): the plugin's line, typed in as a wake; false when nothing is handed.
func (h Harness) HandOver(entry reconciler.Entry) (bool, error) {
	line, ok := h.Plugin.HandOverLine(entry.Folder)
	if !ok {
		return false, nil
	}
	return true, h.Runtime.Send(entry.ShipID, UserLine(prompt.Wake(line)))
}

// ForceOver hands a forced message over (decision 0040), its busy turn stopped first; false when nothing is handed.
func (h Harness) ForceOver(entry reconciler.Entry, isTurnBusy bool) (bool, error) {
	line, ok := h.Plugin.ForceOverLine(entry.Folder)
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
