package guardrules

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

const (
	fleetID  = "flt_01m3tb1zgr5h2ffee12xnch8sv"
	pluginID = "shp_01m6jyczpnpp5c0vxh54c966cz"
	shipID   = "shp_01m6jyczpnpp5c0vxh54c966cy"
)

var configured = Identity{FleetID: fleetID, PluginShipID: pluginID}

func anAssignment(version int) string {
	text, _ := json.Marshal(map[string]any{
		"fleetId": fleetID, "pluginShipId": pluginID, "shipId": shipID,
		"settingsVersion": version, "sets": []any{},
	})
	return string(text)
}

func TestRulesExplicitlyCarryNoSetsForAnAssignment(t *testing.T) {
	got, err := Read(anAssignment(1), configured)
	if err != nil || got.ShipID != shipID || got.SettingsVersion != 1 || got.Sets == nil || len(got.Sets) != 0 {
		t.Fatalf("Read(empty sets) = %+v, %v, want version 1 with explicit empty sets", got, err)
	}
}

func TestRulesRefuseAnotherFleetOrPluginShip(t *testing.T) {
	for _, test := range []struct{ name, old, replacement string }{
		{"fleet", fleetID, "flt_01m3tb1zgr5h2ffee12xnch8sw"},
		{"plugin ship", pluginID, shipID},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := Read(strings.ReplaceAll(anAssignment(1), test.old, test.replacement), configured)
			if !errors.Is(err, ErrRefused) {
				t.Fatalf("Read(%s mismatch) = %v, want a refusal", test.name, err)
			}
		})
	}
}

func TestRulesRequireTheCompleteMessageWithACurrentSettingsVersion(t *testing.T) {
	var fields map[string]any
	if err := json.Unmarshal([]byte(anAssignment(1)), &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"fleetId", "pluginShipId", "shipId", "settingsVersion", "sets"} {
		t.Run("missing "+field, func(t *testing.T) {
			copy := make(map[string]any)
			for key, value := range fields {
				if key != field {
					copy[key] = value
				}
			}
			text, _ := json.Marshal(copy)
			if _, err := Read(string(text), configured); !errors.Is(err, ErrRefused) {
				t.Fatalf("Read(missing %s) = %v, want a refusal", field, err)
			}
		})
	}
	for _, test := range []struct{ name, payload string }{
		{"not JSON", "{"},
		{"null", "null"},
		{"null sets", strings.ReplaceAll(anAssignment(1), `"sets":[]`, `"sets":null`)},
		{"zero version", anAssignment(0)},
		{"negative version", anAssignment(-1)},
		{"fractional version", strings.ReplaceAll(anAssignment(1), `"settingsVersion":1`, `"settingsVersion":1.5`)},
		{"trailing JSON", anAssignment(1) + `{}`},
		{"unknown field", strings.TrimSuffix(anAssignment(1), "}") + `,"other":true}`},
		{"ship path", strings.ReplaceAll(anAssignment(1), shipID, "../../elsewhere")},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Read(test.payload, configured); !errors.Is(err, ErrRefused) {
				t.Fatalf("Read(%s) = %v, want a refusal", test.name, err)
			}
		})
	}
}
