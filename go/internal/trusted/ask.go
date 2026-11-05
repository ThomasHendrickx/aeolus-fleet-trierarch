package trusted

import (
	"fmt"
	"maps"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// Asker is the trierarch plugin's ship, asked for the trusted repositories as the trierarch's own ship.
type Asker interface {
	AskForTrustedRepositories(pluginShipID string) error
}

// Ask asks the trierarch plugin's ship for the trusted repositories (aeolus-fleet#384), so a machine set up before, which dropped the list until init kept that ship, gets it on the trierarch plugin's next pass. It asks once per process; an ask the fleet does not take is asked again on the next pass. A machine that does not know the ship asks nothing.
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
	if err := a.Fleet.AskForTrustedRepositories(a.PluginShipID); err != nil {
		a.Log(fmt.Sprintf("Could not ask the trierarch plugin's ship for the trusted repositories: %v; the next pass asks again", err))
		return
	}
	a.isAsked = true
}

// WithRepositories is the configuration with each trusted repository beside the configured ones, at its clone: what the trierarch reports, trusts and crews in. A configured repository whose name is on the list stays as the machine configured it.
func WithRepositories(configuration config.Configuration, trusted []Repository, cloneOf func(name string) string) config.Configuration {
	offered := make(map[string]config.Repository, len(configuration.Repositories)+len(trusted))
	for _, repository := range trusted {
		offered[repository.Name] = config.Repository{Path: cloneOf(repository.Name)}
	}
	maps.Copy(offered, configuration.Repositories)
	configuration.Repositories = offered
	return configuration
}
