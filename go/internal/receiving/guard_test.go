package receiving

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardrules"
)

const guardPayload = `{"fleetId":"flt_01m3tb1zgr5h2ffee12xnch8sv","pluginShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","shipId":"shp_01m6jyczpnpp5c0vxh54c966cy","settingsVersion":3,"sets":[]}`

type guardStorage struct {
	text []byte
	err  error
}

func (s *guardStorage) Read(context.Context, string) ([]byte, error) {
	return slices.Clone(s.text), nil
}
func (s *guardStorage) Write(_ context.Context, _ string, text []byte) error {
	if s.err != nil {
		return s.err
	}
	s.text = slices.Clone(text)
	return nil
}

type guardShip struct {
	aShip
	storage      *guardStorage
	wasPersisted []bool
	failFirstAck bool
}

func (s *guardShip) Ack(deliveryID string) error {
	s.wasPersisted = append(s.wasPersisted, s.storage.text != nil)
	err := s.aShip.Ack(deliveryID)
	if s.failFirstAck && len(s.acked) == 1 {
		return errors.New("ack failed")
	}
	return err
}

func runWithGuard(t *testing.T, store *guardStorage, deliveries ...Delivery) (*guardShip, []string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ship := &guardShip{aShip: aShip{cancel: cancel, answers: []answer{{deliveries: deliveries}}}, storage: store}
	var logged []string
	Loop{
		Ship: ship, PluginShipID: plugin,
		GuardRules: &guardrules.Keeper{Identity: guardrules.Identity{FleetID: fleet, PluginShipID: plugin}, Store: store},
		Log:        func(line string) { logged = append(logged, line) },
		Pause:      func(context.Context, time.Duration) {},
	}.Run(ctx)
	return ship, logged
}

func guardDelivery(sender, payload string) Delivery {
	return Delivery{DeliveryID: "guard", SenderShipID: sender, ContentType: guardrules.ContentType, Payload: payload}
}

func TestGuardRulesArePersistedBeforeTheDeliveryIsAcknowledged(t *testing.T) {
	store := &guardStorage{}
	ship, logged := runWithGuard(t, store, guardDelivery(plugin, guardPayload))
	if !slices.Equal(ship.acked, []string{"guard"}) || !slices.Equal(ship.wasPersisted, []bool{true}) || len(logged) != 0 {
		t.Fatalf("acked = %v, persisted at ack = %v, logged = %q, want persisted then acknowledged", ship.acked, ship.wasPersisted, logged)
	}
}

func TestGuardRulesAreNotAcknowledgedWhenPersistenceFails(t *testing.T) {
	ship, logged := runWithGuard(t, &guardStorage{err: errors.New("disk full")}, guardDelivery(plugin, guardPayload))
	if len(ship.acked) != 0 || len(logged) != 1 || !strings.Contains(logged[0], "disk full") {
		t.Fatalf("acked = %v, logged = %q, want unacknowledged storage failure", ship.acked, logged)
	}
}

func TestRefusedGuardDeliveriesAreAcknowledgedWithoutChangingStoredRules(t *testing.T) {
	for _, test := range []struct {
		name     string
		delivery Delivery
	}{
		{"another sender", guardDelivery(argo, guardPayload)},
		{"another fleet", guardDelivery(plugin, strings.ReplaceAll(guardPayload, fleet, "flt_01m3tb1zgr5h2ffee12xnch8sw"))},
		{"invalid message", guardDelivery(plugin, "null")},
		{"invalid nested rules", guardDelivery(plugin, strings.Replace(guardPayload, `"sets":[]`, `"sets":[{"name":"base","repository":"fleet/rules","commit":"8d41e07","file":"base.yaml","floor":true,"rules":{"git":{"deny":["unknown-action"]}}}]`, 1))},
		{"older version", guardDelivery(plugin, strings.ReplaceAll(guardPayload, `"settingsVersion":3`, `"settingsVersion":2`))},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &guardStorage{text: []byte(guardPayload)}
			ship, logged := runWithGuard(t, store, test.delivery)
			if !slices.Equal(ship.acked, []string{"guard"}) || string(store.text) != guardPayload || len(logged) != 1 {
				t.Fatalf("acked = %v, rules = %q, logged = %q, want refusal with stored rules unchanged", ship.acked, store.text, logged)
			}
		})
	}
}

func TestRedeliveredRulesAfterAnAckFailureRemainAvailableForRestart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store := &guardStorage{}
	keeper := &guardrules.Keeper{Identity: guardrules.Identity{FleetID: fleet, PluginShipID: plugin}, Store: store}
	ship := &guardShip{aShip: aShip{cancel: cancel, answers: []answer{
		{deliveries: []Delivery{guardDelivery(plugin, guardPayload)}},
		{deliveries: []Delivery{guardDelivery(plugin, guardPayload)}},
	}}, storage: store, failFirstAck: true}
	Loop{Ship: ship, PluginShipID: plugin, GuardRules: keeper, Log: func(string) {}, Pause: func(context.Context, time.Duration) {}}.Run(ctx)
	restarted := &guardrules.Keeper{Identity: keeper.Identity, Store: store}
	got, ok, err := restarted.Current(context.Background(), argo)
	if err != nil || !ok || got.SettingsVersion != 3 || len(ship.acked) != 2 || !slices.Equal(ship.wasPersisted, []bool{true, true}) {
		t.Fatalf("Current after redelivery = %+v, %v, %v, acknowledgements %v, want version 3 retained before both acknowledgements", got, ok, err, ship.acked)
	}
}
