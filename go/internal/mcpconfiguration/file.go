package mcpconfiguration

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"slices"
	"sync"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
)

// Outcome is what applying a configuration did.
type Outcome int

const (
	// Applied is a configuration kept in place of the one held.
	Applied Outcome = iota + 1
	// Unchanged is the version held again, sealed to the same key: nothing changes, and it is confirmed again.
	Unchanged
	// Older is a version below the one held: it never overwrites the newer one.
	Older
)

// outcomeOf is what applying the incoming configuration over the one held does: versions only move forward, and the same version sealed to a new key replaces the copy held.
func outcomeOf(held *Configuration, incoming Configuration) Outcome {
	switch {
	case held == nil || held.Identity != incoming.Identity || incoming.Version > held.Version:
		return Applied
	case incoming.Version < held.Version:
		return Older
	case incoming.PublicKey != held.PublicKey:
		return Applied
	}
	return Unchanged
}

// stored is the file's shape: the configuration as applied, its secrets opened.
type stored struct {
	FleetID      string            `json:"fleetId"`
	PluginShipID string            `json:"pluginShipId"`
	Version      int               `json:"version"`
	PublicKey    string            `json:"publicKey"`
	Servers      json.RawMessage   `json:"servers"`
	Secrets      map[string]string `json:"secrets"`
}

// ReadFile is the configuration the file holds, whoever's it is; false when it is missing or does not fit. The MCP proxy reads it at each call, as the trierarch applies a configuration in another process.
func ReadFile(path string) (Configuration, bool) {
	text, err := secrets.ReadPrivate(path)
	if err != nil {
		return Configuration{}, false
	}
	var held stored
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&held) != nil || held.FleetID == "" || held.PluginShipID == "" || held.Version < 0 || held.PublicKey == "" || held.Servers == nil || held.Secrets == nil {
		return Configuration{}, false
	}
	servers, err := mcpservers.Read(`{"servers":` + string(held.Servers) + `}`)
	if err != nil {
		return Configuration{}, false
	}
	for name, value := range held.Secrets {
		if !secrets.IsName(name) || !secrets.IsValue([]byte(value)) {
			return Configuration{}, false
		}
	}
	return Configuration{Identity: Identity{FleetID: held.FleetID, PluginShipID: held.PluginShipID}, Version: held.Version, PublicKey: held.PublicKey, Servers: servers, Secrets: held.Secrets}, true
}

// File is the MCP configuration file, ~/.aeolus/trierarch/mcp-configuration.json, mode 600: the one configuration of this trierarch's fleet it applied last, its secrets opened. It is safe for the receiving loop that applies a configuration and the passes that read it.
type File struct {
	Path string

	mu      sync.Mutex
	current *Configuration
}

// Load reads the file for the configured identity. A file of another fleet or plugin ship is removed, so a version is never taken under another identity and no launch uses it; one that is missing or does not fit holds none.
func (f *File) Load(configured Identity) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current = nil
	held, ok := ReadFile(f.Path)
	if !ok {
		return
	}
	if held.Identity != configured {
		_ = os.Remove(f.Path)
		return
	}
	f.current = &held
}

// Current is the configuration as the trierarch applied it; false when it holds none.
func (f *File) Current() (Configuration, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.current == nil {
		return Configuration{}, false
	}
	return clone(*f.current), true
}

// Apply keeps the configuration in place of the one held, unless it is the same version sealed to the same key or an older one. It is persisted whole, through a new file renamed into place, before it is held.
func (f *File) Apply(configuration Configuration) (Outcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	outcome := outcomeOf(f.current, configuration)
	if outcome != Applied {
		return outcome, nil
	}
	servers, err := json.Marshal(configuration.Servers)
	if err != nil {
		return 0, err
	}
	held := maps.Clone(configuration.Secrets)
	if held == nil {
		held = map[string]string{}
	}
	text, err := json.Marshal(stored{FleetID: configuration.FleetID, PluginShipID: configuration.PluginShipID, Version: configuration.Version, PublicKey: configuration.PublicKey, Servers: servers, Secrets: held})
	if err != nil {
		return 0, err
	}
	if err := secrets.WritePrivate(f.Path, append(text, '\n')); err != nil {
		return 0, fmt.Errorf("keep the MCP configuration: %w", err)
	}
	kept := clone(configuration)
	f.current = &kept
	return Applied, nil
}

func clone(configuration Configuration) Configuration {
	configuration.Servers = slices.Clone(configuration.Servers)
	configuration.Secrets = maps.Clone(configuration.Secrets)
	return configuration
}
