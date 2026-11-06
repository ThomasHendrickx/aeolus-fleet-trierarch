package mcpservers

import "fmt"

// Asker is the trierarch plugin's ship, asked for the MCP servers as the trierarch's own ship.
type Asker interface {
	AskForMcpServers(pluginShipID string) error
}

// Ask asks the trierarch plugin's ship for the MCP servers, so a trierarch that started before the list was sent gets it on the trierarch plugin's next pass. It asks once per process; an ask the fleet does not take is asked again on the next pass. A machine that does not know the ship asks nothing.
type Ask struct {
	Fleet        Asker
	PluginShipID string
	Log          func(line string)

	isAsked bool
}

// Once asks, unless it asked already or the machine does not know the ship.
func (a *Ask) Once() {
	if a.isAsked || a.PluginShipID == "" {
		return
	}
	if err := a.Fleet.AskForMcpServers(a.PluginShipID); err != nil {
		a.Log(fmt.Sprintf("Could not ask the trierarch plugin's ship for the MCP servers: %v; the next pass asks again", err))
		return
	}
	a.isAsked = true
}
