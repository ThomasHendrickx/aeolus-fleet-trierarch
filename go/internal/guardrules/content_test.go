package guardrules

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestSameVersionCannotChangeResolvedSetMetadataOrRules(t *testing.T) {
	original := withSets(3, aResolvedSet(`{"git":{"deny":["push"]}}`))
	for _, change := range []struct{ name, old, replacement string }{
		{"rules", `"push"`, `"skip-hooks"`},
		{"commit", "8d41e079bd56801e1e2acf18f094c22ade5ec8a9", "9d41e079bd56801e1e2acf18f094c22ade5ec8a9"},
		{"floor", `"floor":true`, `"floor":false`},
		{"repository", "fleet/rules", "other/rules"},
		{"file", "guards/no-push.yaml", "other/no-push.yaml"},
		{"name", "no-push", "base"},
	} {
		t.Run(change.name, func(t *testing.T) {
			store := &memoryRules{}
			if _, err := aKeeper(store).Accept(context.Background(), pluginID, original); err != nil {
				t.Fatal(err)
			}
			before := slices.Clone(store.files[shipID])
			outcome, err := aKeeper(store).Accept(context.Background(), pluginID, strings.ReplaceAll(original, change.old, change.replacement))
			if outcome != Refused || !errors.Is(err, ErrRefused) || !slices.Equal(before, store.files[shipID]) {
				t.Fatalf("Accept(changed %s at same version) = %v, %v, want refusal with stored resolution unchanged", change.name, outcome, err)
			}
		})
	}
}

func TestDuplicateRulesIgnoreJSONKeyOrderAndFormatting(t *testing.T) {
	store := &memoryRules{}
	original := withSets(3, aResolvedSet(`{"commands":{"deny":[{"command":"npm","args":["publish"]}]},"git":{"deny":["push"]}}`))
	if _, err := aKeeper(store).Accept(context.Background(), pluginID, original); err != nil {
		t.Fatal(err)
	}
	before := slices.Clone(store.files[shipID])
	duplicate := withSets(3, `{
		"rules":{"git":{"deny":["push"]},"commands":{"deny":[{"args":["publish"],"command":"npm"}]}},
		"floor":true,"file":"guards/no-push.yaml","commit":"8d41e079bd56801e1e2acf18f094c22ade5ec8a9",
		"repository":"fleet/rules","name":"no-push"
	}`)
	store.writeErr = errors.New("duplicates must not rewrite storage")
	outcome, err := aKeeper(store).Accept(context.Background(), pluginID, duplicate)
	if outcome != Unchanged || err != nil || !slices.Equal(before, store.files[shipID]) {
		t.Fatalf("Accept(reordered identical JSON) = %v, %v, want unchanged", outcome, err)
	}
}

func TestOnlyANewerVersionCanReplaceNonemptyRulesWithNoSets(t *testing.T) {
	store := &memoryRules{}
	if _, err := aKeeper(store).Accept(context.Background(), pluginID, withSets(3, aResolvedSet(`{"git":{"deny":["push"]}}`))); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		version int
		outcome Outcome
	}{{3, Refused}, {4, Applied}} {
		outcome, err := aKeeper(store).Accept(context.Background(), pluginID, anAssignment(test.version))
		if outcome != test.outcome || (err != nil && !errors.Is(err, ErrRefused)) {
			t.Fatalf("Accept(empty version %d) = %v, %v, want %v", test.version, outcome, err, test.outcome)
		}
	}
	got, ok, err := aKeeper(store).Current(context.Background(), shipID)
	if err != nil || !ok || got.SettingsVersion != 4 || len(got.Sets) != 0 {
		t.Fatalf("Current = %+v, %v, %v, want explicit empty version 4", got, ok, err)
	}
}

func TestInvalidNestedRulesNeverReplaceTheStoredResolution(t *testing.T) {
	store := &memoryRules{}
	if _, err := aKeeper(store).Accept(context.Background(), pluginID, withSets(3, aResolvedSet(`{"git":{"deny":["push"]}}`))); err != nil {
		t.Fatal(err)
	}
	before := slices.Clone(store.files[shipID])
	outcome, err := aKeeper(store).Accept(context.Background(), pluginID, withSets(4, aResolvedSet(`{"git":{"deny":["unknown-action"]}}`)))
	if outcome != Refused || !errors.Is(err, ErrRefused) || !slices.Equal(before, store.files[shipID]) {
		t.Fatalf("Accept(invalid nested version 4) = %v, %v, want refused and unchanged", outcome, err)
	}
}
