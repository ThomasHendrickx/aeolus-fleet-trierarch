package reconciler

import (
	"maps"
	"slices"
	"testing"
)

// withModels is the context with Claude Code offering the models given, in their order, and effort high.
func withModels(context Context, models ...string) Context {
	context.Options = map[string]map[string][]string{"claude-code": {"model": models, "effort": {"high"}}}
	return context
}

func TestARequestPickingAValueTheHarnessDoesNotOfferIsGivenBackNamingTheValuesItOffers(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Options = map[string]string{"model": "claude-sonnet-5"}

	next, actions := Reconcile(Empty(), withModels(aContext(request), "claude-opus-5", "claude-haiku-5"))

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "options.model: model must be one of claude-opus-5, claude-haiku-5"})
	if len(next.Entries) != 0 {
		t.Errorf("entries = %+v, want none", next.Entries)
	}
}

func TestARequestPickingOfferedValuesIsCrewedWithThem(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Options = map[string]string{"model": "claude-opus-5", "effort": "high"}

	next, actions := Reconcile(Empty(), withModels(aContext(request), "claude-opus-5"))

	assertActions(t, actions, Action{Kind: Crew, ShipID: scout})
	if got, want := next.Entries[scout].Options, map[string]string{"model": "claude-opus-5", "effort": "high"}; !maps.Equal(got, want) {
		t.Errorf("options = %v, want %v", got, want)
	}
}

func TestAnOptionTheHarnessDoesNotDeclareIsIgnored(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Options = map[string]string{"model": "claude-opus-5", "temperature": "hot"}

	next, actions := Reconcile(Empty(), withModels(aContext(request), "claude-opus-5"))

	assertActions(t, actions, Action{Kind: Crew, ShipID: scout})
	if got, want := next.Entries[scout].Options, map[string]string{"model": "claude-opus-5"}; !maps.Equal(got, want) {
		t.Errorf("options = %v, want %v", got, want)
	}
}

func TestANewSettingsVersionPickingAValueNoLongerOfferedIsGivenBack(t *testing.T) {
	request := aRequest(scout)
	request.SettingsVersion = 2
	request.Settings.Options = map[string]string{"model": "claude-sonnet-5"}
	entry := anEntry(scout, "running")

	_, actions := Reconcile(withEntries(entry), withModels(aContext(request), "claude-opus-5"))

	given := entry
	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 2, Reason: "options.model: model must be one of claude-opus-5", Entry: &given})
}

func TestARequestPickingAModelTheHarnessDoesNotOfferNamesItsHarnessToConfirmAgain(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Options = map[string]string{"model": "claude-sonnet-5"}

	got := ModelsToConfirm(Empty(), withModels(aContext(request), "claude-opus-5"))

	if want := []string{"claude-code"}; !slices.Equal(got, want) {
		t.Errorf("ModelsToConfirm() = %v, want %v", got, want)
	}
}

func TestARequestPickingAnOfferedModelOrOneGivenBackOrFinalNamesNoHarnessToConfirmAgain(t *testing.T) {
	offered := aRequest(scout)
	offered.Settings.Options = map[string]string{"model": "claude-opus-5"}
	givenBack := aRequest("shp_back")
	givenBack.Settings.Options = map[string]string{"model": "claude-sonnet-5"}
	final := aRequest("shp_final")
	final.Settings.Options = map[string]string{"model": "claude-sonnet-5"}
	final.IsFinal = true
	state := Empty()
	state.Refused["shp_back"] = 1

	got := ModelsToConfirm(state, withModels(aContext(offered, givenBack, final), "claude-opus-5"))

	if len(got) != 0 {
		t.Errorf("ModelsToConfirm() = %v, want none", got)
	}
}
