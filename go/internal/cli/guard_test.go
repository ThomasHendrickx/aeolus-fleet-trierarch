package cli

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardrules"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/receiving"
)

const guardAssignment = `{"fleetId":"flt_01m3tb1zgr5h2ffee12xnch8sv","pluginShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","shipId":"shp_01m6jyczpnpp5c0vxh54c966cy","settingsVersion":3,"sets":[]}`

type aRulesShip struct {
	delivery *receiving.Delivery
	stop     chan struct{}
	acked    []string
}

func (s *aRulesShip) Receive(ctx context.Context) ([]receiving.Delivery, error) {
	if s.delivery != nil {
		delivery := *s.delivery
		s.delivery = nil
		return []receiving.Delivery{delivery}, nil
	}
	<-ctx.Done()
	return nil, ctx.Err()
}
func (s *aRulesShip) Ack(id string) error { s.acked = append(s.acked, id); close(s.stop); return nil }
func (*aRulesShip) Pong(string) error     { return nil }

func TestRunKeepsRulesForItsConfiguredFleetAndPluginShip(t *testing.T) {
	machine, _, _ := aMain(t)
	if output, code := Main(setupWords(), machine); code != 0 {
		t.Fatalf("init = %q, %d", output, code)
	}
	stop := make(chan struct{})
	ship := &aRulesShip{stop: stop, delivery: &receiving.Delivery{DeliveryID: "rules", SenderShipID: pluginShipID, ContentType: guardrules.ContentType, Payload: strings.ReplaceAll(guardAssignment, "shp_01m6jyczpnpp5c0vxh54c966cz", pluginShipID)}}
	machine.Stop = stop
	machine.PassEvery = time.Hour
	machine.OwnShip = func(crew.File) receiving.Ship { return ship }
	machine.McpFleet = func(crew.File) McpFleet { return anMcpFleet{fleetID: "flt_01m3tb1zgr5h2ffee12xnch8sv"} }
	var keeper *guardrules.Keeper
	machine.GuardRules = func(at paths.Paths, identity guardrules.Identity) receiving.GuardKeeper {
		keeper = &guardrules.Keeper{Identity: identity, Store: guardfile.Store{Guards: at.Guard}}
		return keeper
	}
	if output, code := Main([]string{"run"}, machine); code != 0 {
		t.Fatalf("run = %q, %d", output, code)
	}
	if keeper == nil {
		t.Fatal("run did not supply a guard rules keeper")
	}
	got, ok, err := keeper.Current(context.Background(), "shp_01m6jyczpnpp5c0vxh54c966cy")
	if err != nil || !ok || got.SettingsVersion != 3 || !slices.Equal(ship.acked, []string{"rules"}) {
		t.Fatalf("Current = %+v, %v, %v, acked %v, want persisted version 3", got, ok, err, ship.acked)
	}
}

type anUnavailableRulesFleet struct{ anMcpFleet }

func (anUnavailableRulesFleet) FleetID() (string, error) {
	return "", errors.New("fleet identity unavailable")
}

func TestRunDoesNotReceiveRulesWithoutKnowingItsFleetIdentity(t *testing.T) {
	machine, _, _ := aMain(t)
	if output, code := Main(setupWords(), machine); code != 0 {
		t.Fatalf("init = %q, %d", output, code)
	}
	machine.McpFleet = func(crew.File) McpFleet { return anUnavailableRulesFleet{} }
	machine.GuardRules = func(paths.Paths, guardrules.Identity) receiving.GuardKeeper {
		t.Fatal("created rules keeper without identity")
		return nil
	}
	if output, code := Main([]string{"run"}, machine); code != 1 || !strings.Contains(output, "fleet identity unavailable") {
		t.Fatalf("run = %q, %d, want fleet identity failure", output, code)
	}
}
