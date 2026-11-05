// Package copilot is the GitHub Copilot CLI as a harness (docs/architecture.md,
// "First adapters"; design harnesses/cursor-copilot, CC3, CC4, CC6), headless
// on the host: one `copilot -p` per turn under each ship's hold. Copilot signs
// in with the machine's own login, which the hold's clean environment leaves
// alone: no GitHub token reaches a session, and no API key (CC6). The identity
// and the turn marker go through the aeolus-fleet plugin Copilot installed,
// whose hooks run in `copilot -p` as in a terminal (S3). The machine offers
// Copilot only with that plugin installed, on a Copilot CLI build its hooks
// are proven on.
package copilot

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/prompt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

// Runtime is the session runtime as a harness uses it: start a session, send it a line, stop its turn.
type Runtime interface {
	Start(session sessions.Start) error
	Send(shipID string, line string) error
	Interrupt(shipID string) error
}

// launchVariable is the variable a session's launch id is passed in, for the plugin's hooks to mark that launch (#490).
const launchVariable = "AEOLUS_LAUNCH"

// copilotHomeVariable is the variable Copilot reads its configuration folder from, which the trierarch found its plugin in.
const copilotHomeVariable = "COPILOT_HOME"

// Harness is Copilot as the run pass starts and watches its sessions, each under its hold; the identity, turn and store through the aeolus-fleet plugin Copilot installed.
type Harness struct {
	plugin.Plugin
	Runtime  Runtime
	Settings config.Harness
	// Events is where the ship's hold keeps every line its session wrote.
	Events func(shipID string) string
	// Version is the Copilot CLI's version, read each time it is asked; false when it says none.
	Version func() (string, bool)
	// CopilotHome is the trierarch's COPILOT_HOME, which its sessions get so they use the login and plugin it found; empty when it has none.
	CopilotHome string
}

// Launch starts the entry's session in its folder: its first turn with its first prompt on a first start, else the wake resuming the session its last turn named, read before the start, which clears the session's events.
func (h Harness) Launch(entry reconciler.Entry, isFirstStart bool, launchID string) error {
	if entry.Login != "" && entry.Login != "subscription" {
		return errors.New("copilot signs in with this computer's own login (copilot login): it runs on no API key")
	}
	line, sessionID := prompt.Wake(WakePrompt), ""
	if isFirstStart && entry.FirstPrompt != "" {
		line = prompt.First(entry.FirstPrompt)
	}
	if !isFirstStart {
		sessionID = LastSessionIn(h.Events(entry.ShipID))
	}
	command := CommandLine(h.Settings.EffectiveFlags(entry.Options), line, sessionID)
	if err := h.ClearLaunch(entry.Folder); err != nil {
		return err
	}
	env := map[string]string{launchVariable: launchID}
	if h.CopilotHome != "" {
		env[copilotHomeVariable] = h.CopilotHome
	}
	return h.Runtime.Start(sessions.Start{ShipID: entry.ShipID, Folder: entry.Folder, Harness: "copilot", Command: command, Env: env})
}

// LaunchSeen is what the session did in its launch window, as its marker says; with no activity, the cause Copilot's last error gives (H13).
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

// Problem is why the machine does not offer Copilot now (CC3): its plugin not installed, which the trierarch's upgrade does not install, so the reason says Copilot's own command; its version not found; or a build its plugin's hooks are not proven on.
func (h Harness) Problem() error {
	if h.IsInstalled() != nil {
		return errors.New("its aeolus-fleet plugin is not installed for Copilot: copilot plugin install aeolus-fleet@aeolus-fleet")
	}
	proven := []string{}
	for _, version := range ProvenVersions {
		proven = append(proven, "Copilot CLI "+version)
	}
	onProven := "the hooks of its aeolus-fleet plugin are proven on " + strings.Join(proven, ", ")
	version, ok := h.Version()
	if !ok {
		return errors.New("its Copilot CLI version is not detected yet: " + onProven)
	}
	if !slices.Contains(ProvenVersions, version) {
		return fmt.Errorf("copilot CLI %s is not proven: %s", version, onProven)
	}
	return nil
}

func (h Harness) WriteIdentity(entry reconciler.Entry, identity plugin.Identity, crewToken string) error {
	return h.Plugin.WriteIdentity(entry.Folder, identity, crewToken)
}

func (h Harness) HasIdentity(entry reconciler.Entry) bool { return h.Plugin.HasIdentity(entry.Folder) }

func (h Harness) DeleteIdentity(entry reconciler.Entry) error { return h.Plugin.DeleteIdentity(entry.Folder) }

func (h Harness) SessionDied(entry reconciler.Entry) error { return h.Plugin.SessionDied(entry.Folder) }

func (h Harness) Turn(entry reconciler.Entry) string { return h.Plugin.Turn(entry.Folder) }

func (h Harness) IsHolding(entry reconciler.Entry) bool { return h.Plugin.IsHolding(entry.Folder) }
