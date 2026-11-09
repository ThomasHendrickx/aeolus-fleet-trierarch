// Package mcpconfiguration is a fleet's crew-time MCP configuration
// (aeolus-fleet docs/design/fleet-crew-mcp, section 5): the trierarch plugin's
// complete, versioned set of the fleet's MCP servers and their secrets, sent
// to each trierarch of the fleet with the secrets sealed to that trierarch's
// key. A trierarch takes it only from its configured plugin ship, for its own
// fleet and key, and only whole: one entry that does not fit and none of it is
// taken. No refusal says a secret's value.
package mcpconfiguration

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
)

// ContentType is the content type of the message that carries the configuration from the trierarch plugin.
const ContentType = "application/vnd.aeolus.trierarch.mcp-configuration+json"

// RequestContentType is the content type of the message a trierarch asks its plugin ship for the current configuration with.
const RequestContentType = "application/vnd.aeolus.trierarch.mcp-configuration-request+json"

// AppliedContentType is the content type of the message a trierarch confirms a persisted configuration to its plugin ship with.
const AppliedContentType = "application/vnd.aeolus.trierarch.mcp-configuration-applied+json"

// IdentityMismatch is the reason a configuration, or a proxy call, of another fleet or plugin ship is refused with.
const IdentityMismatch = "MCP_CONFIGURATION_IDENTITY_MISMATCH"

// ErrIdentityMismatch is a configuration for another fleet or plugin ship than this trierarch's.
var ErrIdentityMismatch = errors.New(IdentityMismatch)

// Identity is whose a configuration is: the fleet and the plugin ship that supplies it.
type Identity struct {
	FleetID      string `json:"fleetId"`
	PluginShipID string `json:"pluginShipId"`
}

// Configuration is a fleet's complete crew-time MCP configuration, its secrets opened.
type Configuration struct {
	Identity
	Version   int
	PublicKey string
	Servers   []mcpservers.Server
	Secrets   map[string]string
}

// SecretNames are the names of the secrets the configuration holds, in order; never a value.
func (c Configuration) SecretNames() []string {
	return slices.Sorted(maps.Keys(c.Secrets))
}

// message is the configuration message's payload, every field required.
type message struct {
	FleetID      *string          `json:"fleetId"`
	PluginShipID *string          `json:"pluginShipId"`
	Version      *int             `json:"version"`
	PublicKey    *string          `json:"publicKey"`
	Servers      *json.RawMessage `json:"servers"`
	Secrets      *json.RawMessage `json:"secrets"`
}

var errShape = errors.New(`the MCP configuration is { "fleetId", "pluginShipId", "version", "publicKey", "servers", "secrets": [{ "name", "sealed" }] }`)

// Read is the configuration the message's payload carries, its secrets opened with the key, or why not: for the configured identity, sealed to this key, every server and secret fitting.
func Read(payload string, configured Identity, key secrets.Key) (Configuration, error) {
	var read message
	decoder := json.NewDecoder(bytes.NewReader([]byte(payload)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&read) != nil || read.FleetID == nil || read.PluginShipID == nil || read.Version == nil || read.PublicKey == nil || read.Servers == nil || read.Secrets == nil {
		return Configuration{}, errShape
	}
	identity := Identity{FleetID: *read.FleetID, PluginShipID: *read.PluginShipID}
	if identity != configured {
		return Configuration{}, fmt.Errorf("%w: the MCP configuration is for fleet %s and plugin ship %s, this trierarch's are %s and %s", ErrIdentityMismatch, identity.FleetID, identity.PluginShipID, configured.FleetID, configured.PluginShipID)
	}
	if *read.Version < 0 {
		return Configuration{}, errors.New("the MCP configuration's version is a whole number, 0 or more")
	}
	servers, err := mcpservers.Read(`{"servers":` + string(*read.Servers) + `}`)
	if err != nil {
		return Configuration{}, err
	}
	sealed, err := json.Marshal(map[string]any{"publicKey": *read.PublicKey, "secrets": *read.Secrets})
	if err != nil {
		return Configuration{}, errShape
	}
	opened, err := secrets.Read(string(sealed), key)
	if err != nil {
		return Configuration{}, err
	}
	return Configuration{Identity: identity, Version: *read.Version, PublicKey: *read.PublicKey, Servers: servers, Secrets: opened}, nil
}

// AppliedPayload is the payload of the confirmation that the configuration is persisted: its identity, version and recipient key.
func AppliedPayload(configuration Configuration) string {
	text, _ := json.Marshal(struct {
		FleetID      string `json:"fleetId"`
		PluginShipID string `json:"pluginShipId"`
		Version      int    `json:"version"`
		PublicKey    string `json:"publicKey"`
	}{configuration.FleetID, configuration.PluginShipID, configuration.Version, configuration.PublicKey})
	return string(text)
}

// RequestPayload is the payload of the request for the current configuration: the identity it is asked for.
func RequestPayload(identity Identity) string {
	text, _ := json.Marshal(identity)
	return string(text)
}
