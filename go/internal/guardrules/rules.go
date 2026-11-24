// Package guardrules keeps the rules resolved for a ship's crew settings
// version, as aeolus-fleet docs/design/guard sections 4.4 and 4.5 specify.
package guardrules

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
)

// ContentType carries resolved guard rules from the trierarch plugin ship.
const ContentType = "application/vnd.aeolus.trierarch.guard-rules+json"

// ErrRefused marks a rules message that must not replace the rules held.
var ErrRefused = errors.New("guard rules refused")

// Identity is the fleet and plugin ship supplying this trierarch's rules.
type Identity struct {
	FleetID      string
	PluginShipID string
}

// Assignment is the complete rule resolution pinned to a settings version.
type Assignment struct {
	FleetID         string            `json:"fleetId"`
	PluginShipID    string            `json:"pluginShipId"`
	ShipID          string            `json:"shipId"`
	SettingsVersion int               `json:"settingsVersion"`
	Sets            []json.RawMessage `json:"sets"`
}

// Read checks the rules message for the configured fleet and plugin ship.
func Read(payload string, configured Identity) (Assignment, error) {
	var message struct {
		FleetID         *string            `json:"fleetId"`
		PluginShipID    *string            `json:"pluginShipId"`
		ShipID          *string            `json:"shipId"`
		SettingsVersion *int               `json:"settingsVersion"`
		Sets            *[]json.RawMessage `json:"sets"`
	}
	decoder := json.NewDecoder(bytes.NewBufferString(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&message) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		message.FleetID == nil || message.PluginShipID == nil || message.ShipID == nil ||
		message.SettingsVersion == nil || message.Sets == nil {
		return Assignment{}, fmt.Errorf("%w: invalid message", ErrRefused)
	}
	if configured.FleetID == "" || configured.PluginShipID == "" ||
		*message.FleetID != configured.FleetID || *message.PluginShipID != configured.PluginShipID {
		return Assignment{}, fmt.Errorf("%w: fleet or plugin ship does not match", ErrRefused)
	}
	if !crew.IsShipID(*message.ShipID) || *message.SettingsVersion < 1 {
		return Assignment{}, fmt.Errorf("%w: invalid ship or settings version", ErrRefused)
	}
	return Assignment{
		FleetID: *message.FleetID, PluginShipID: *message.PluginShipID, ShipID: *message.ShipID,
		SettingsVersion: *message.SettingsVersion, Sets: *message.Sets,
	}, nil
}
