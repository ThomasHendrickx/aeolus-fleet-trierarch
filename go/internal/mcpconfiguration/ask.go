package mcpconfiguration

import "fmt"

// Asker is the trierarch plugin's ship, asked for the configuration and told of the one persisted, as the trierarch's own ship.
type Asker interface {
	AskForMcpConfiguration(pluginShipID string, payload string) error
	ConfirmMcpConfiguration(pluginShipID string, payload string) error
}

// Ask is what a trierarch does once per start: it confirms the version it persisted, which the plugin ship may never have heard of when it stopped before confirming, and asks for the current configuration, so it converges on the latest set. What the fleet does not take is tried again on the next pass. Nothing is asked before the file is loaded for this trierarch's fleet and plugin ship.
type Ask struct {
	Fleet Asker
	File  *File
	Log   func(line string)

	isAsked bool
}

// Once confirms and asks, unless it did so already or the file is not loaded.
func (a *Ask) Once() {
	identity, ok := a.File.Identity()
	if a.isAsked || !ok {
		return
	}
	if held, ok := a.File.Current(); ok {
		if err := a.Fleet.ConfirmMcpConfiguration(identity.PluginShipID, AppliedPayload(held)); err != nil {
			a.Log(fmt.Sprintf("Could not confirm MCP configuration version %d to the trierarch plugin's ship: %v; the next pass tries again", held.Version, err))
			return
		}
	}
	if err := a.Fleet.AskForMcpConfiguration(identity.PluginShipID, RequestPayload(identity)); err != nil {
		a.Log(fmt.Sprintf("Could not ask the trierarch plugin's ship for the MCP configuration: %v; the next pass asks again", err))
		return
	}
	a.isAsked = true
}
