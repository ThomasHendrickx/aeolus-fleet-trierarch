package usage

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

func TestWorkingMinutesShareThePreReleaseUsageSnapshot(t *testing.T) {
	stage := aShipEntry("shp_stage", "claude-code", "/stage")
	quiet := aShipEntry("shp_quiet", "copilot", "/quiet")
	unknown := aShipEntry("shp_unknown", "claude-code", "/unknown")
	uncrewed := aShipEntry("shp_crewing", "claude-code", "/crewing")
	stage.State, quiet.State, unknown.State = "running", "running", "running"
	stage.CrewToken, quiet.CrewToken, unknown.CrewToken = "crew", "crew", "crew"
	claude := &aHarness{tokens: map[string][]HourTokens{
		stage.ShipID: {{Model: "claude-haiku-5-5", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 100_000, Output: 200_000}}},
	}}
	reader, clock, _ := aReader(map[string]Harness{"claude-code": claude}, stage, quiet, unknown, uncrewed)
	reader.WorkingTime = func(entry reconciler.Entry, now time.Time) (time.Duration, bool) {
		if now != clock.now {
			t.Fatalf("working time read at %s, want %s", now, clock.now)
		}
		switch entry.ShipID {
		case stage.ShipID:
			return 90 * time.Second, true
		case quiet.ShipID:
			return 0, true
		case unknown.ShipID:
			return 0, false
		default:
			t.Fatalf("read working time for uncrewed ship %s", entry.ShipID)
			return 0, false
		}
	}
	got := map[string]string{}
	for _, ship := range mustRead(t, reader).Ships {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal([]byte(mustJSON(t, ship)), &fields); err != nil {
			t.Fatal(err)
		}
		got[ship.ShipID] = string(fields["activeMinutes"])
		if ship.ShipID == stage.ShipID && (len(ship.Models) != 1 || ship.Models[0].EstimatedCostUSD == nil || *ship.Models[0].EstimatedCostUSD != 0.11) {
			t.Fatalf("the stage's models = %+v, want its existing estimated cost", ship.Models)
		}
	}
	if len(got) != 3 || got[stage.ShipID] != "1.5" || got[quiet.ShipID] != "0" || got[unknown.ShipID] != "null" {
		t.Fatalf("reported working minutes = %v, want stage 1.5, quiet 0 and unknown null", got)
	}
}
