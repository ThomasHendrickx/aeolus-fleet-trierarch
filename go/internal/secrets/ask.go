package secrets

import "fmt"

// Asker is the trierarch plugin's ship, asked for the secrets as the trierarch's own ship.
type Asker interface {
	AskForSecrets(pluginShipID string) error
}

// Ask asks the trierarch plugin's ship for the secrets, so a trierarch whose key the trierarch plugin has not sealed to yet gets them on its next pass. It asks once per process; an ask the fleet does not take is asked again on the next pass. A machine that does not know the ship asks nothing.
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
	if err := a.Fleet.AskForSecrets(a.PluginShipID); err != nil {
		a.Log(fmt.Sprintf("Could not ask the trierarch plugin's ship for the secrets: %v; the next pass asks again", err))
		return
	}
	a.isAsked = true
}
