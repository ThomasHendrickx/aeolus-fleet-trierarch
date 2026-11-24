package guardrules

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
)

// memoryRules is the durable storage boundary, reused when a keeper restarts.
type memoryRules struct {
	files             map[string][]byte
	readErr, writeErr error
}

func (m *memoryRules) Read(_ context.Context, ship string) ([]byte, error) {
	return slices.Clone(m.files[ship]), m.readErr
}

func (m *memoryRules) Write(_ context.Context, ship string, text []byte) error {
	if m.writeErr != nil {
		return m.writeErr
	}
	if m.files == nil {
		m.files = make(map[string][]byte)
	}
	m.files[ship] = slices.Clone(text)
	return nil
}

func aKeeper(store *memoryRules) *Keeper { return &Keeper{Identity: configured, Store: store} }

func TestRulesFromThePluginShipSurviveAKeeperRestart(t *testing.T) {
	store := &memoryRules{}
	outcome, err := aKeeper(store).Accept(context.Background(), pluginID, anAssignment(3))
	if err != nil || outcome != Applied {
		t.Fatalf("Accept = %v, %v, want applied", outcome, err)
	}

	got, ok, err := aKeeper(store).Current(context.Background(), shipID)
	if err != nil || !ok || got.SettingsVersion != 3 || len(got.Sets) != 0 {
		t.Fatalf("Current after restart = %+v, %v, %v, want version 3", got, ok, err)
	}
}

func TestRulesFromAnotherSenderNeverReachStorage(t *testing.T) {
	store := &memoryRules{}
	for _, sender := range []string{shipID, ""} {
		outcome, err := aKeeper(store).Accept(context.Background(), sender, anAssignment(1))
		if outcome != Refused || !errors.Is(err, ErrRefused) || len(store.files) != 0 {
			t.Fatalf("Accept(sender %q) = %v, %v, stored %v, want a refusal and no stored rules", sender, outcome, err, store.files)
		}
	}
}

func TestInvalidRulesNeverReplaceWhatWasPersisted(t *testing.T) {
	store := &memoryRules{}
	keeper := aKeeper(store)
	if _, err := keeper.Accept(context.Background(), pluginID, anAssignment(3)); err != nil {
		t.Fatal(err)
	}
	before := slices.Clone(store.files[shipID])

	outcome, err := keeper.Accept(context.Background(), pluginID, "null")
	if outcome != Refused || !errors.Is(err, ErrRefused) || !slices.Equal(before, store.files[shipID]) {
		t.Fatalf("Accept(invalid) = %v, %v, want refusal with stored rules unchanged", outcome, err)
	}
}

func TestRulesVersionsOnlyMoveForwardAcrossRestarts(t *testing.T) {
	store := &memoryRules{}
	for _, test := range []struct {
		version int
		outcome Outcome
	}{
		{3, Applied}, {4, Applied}, {3, Refused}, {4, Unchanged},
	} {
		keeper := aKeeper(store)
		outcome, err := keeper.Accept(context.Background(), pluginID, anAssignment(test.version))
		if outcome != test.outcome || (err != nil && !errors.Is(err, ErrRefused)) {
			t.Fatalf("Accept(version %d) = %v, %v, want %v", test.version, outcome, err, test.outcome)
		}
	}
	got, ok, err := aKeeper(store).Current(context.Background(), shipID)
	if err != nil || !ok || got.SettingsVersion != 4 {
		t.Fatalf("Current = %+v, %v, %v, want version 4", got, ok, err)
	}
}

func TestMissingRulesAreNotAnEmptyResolution(t *testing.T) {
	got, ok, err := aKeeper(&memoryRules{}).Current(context.Background(), shipID)
	if err != nil || ok {
		t.Fatalf("Current(missing) = %+v, %v, %v, want no resolution", got, ok, err)
	}
}

func TestRulesAreNotAppliedWhenPersistenceFails(t *testing.T) {
	failure := errors.New("disk full")
	store := &memoryRules{writeErr: failure}
	outcome, err := aKeeper(store).Accept(context.Background(), pluginID, anAssignment(3))
	if outcome == Applied || !errors.Is(err, failure) || len(store.files) != 0 {
		t.Fatalf("Accept(write failure) = %v, %v, want disk failure with nothing stored", outcome, err)
	}
	store.writeErr = nil
	if outcome, err := aKeeper(store).Accept(context.Background(), pluginID, anAssignment(3)); outcome != Applied || err != nil {
		t.Fatalf("Accept(retry) = %v, %v, want applied", outcome, err)
	}
}

func TestUnreadableRulesNeverLetAVersionOverwriteWhatIsHeld(t *testing.T) {
	failure := errors.New("cannot read rules")
	store := &memoryRules{readErr: failure}
	if outcome, err := aKeeper(store).Accept(context.Background(), pluginID, anAssignment(3)); outcome != 0 || !errors.Is(err, failure) {
		t.Fatalf("Accept(read failure) = %v, %v, want storage error", outcome, err)
	}
	if _, _, err := aKeeper(store).Current(context.Background(), shipID); !errors.Is(err, failure) {
		t.Fatalf("Current(read failure) = %v, want storage error", err)
	}
}

func TestStoredRulesMustBelongToTheShipTheyAreReadFor(t *testing.T) {
	otherShip := "shp_01m6jyczpnpp5c0vxh54c966cx"
	store := &memoryRules{files: map[string][]byte{otherShip: []byte(anAssignment(3))}}
	if got, ok, err := aKeeper(store).Current(context.Background(), otherShip); err == nil || ok {
		t.Fatalf("Current(wrong ship) = %+v, %v, %v, want no resolution and an error", got, ok, err)
	}
}

func TestConcurrentDeliveriesNeverReplaceNewerRulesWithOlderRules(t *testing.T) {
	store := &memoryRules{}
	keeper := aKeeper(store)
	var done sync.WaitGroup
	for version := 1; version <= 20; version++ {
		done.Go(func() { _, _ = keeper.Accept(context.Background(), pluginID, anAssignment(version)) })
	}
	done.Wait()
	got, ok, err := keeper.Current(context.Background(), shipID)
	if err != nil || !ok || got.SettingsVersion != 20 {
		t.Fatalf("Current(concurrent deliveries) = %+v, %v, %v, want version 20", got, ok, err)
	}
}
