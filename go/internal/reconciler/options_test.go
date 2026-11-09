package reconciler

import (
	"maps"
	"slices"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// withModels is the context with Claude Code offering the models given, in their order, and effort high, each with its flag.
func withModels(context Context, models ...string) Context {
	context.Options = map[string]map[string][]string{"claude-code": {"model": models, "effort": {"high"}}}
	model := config.Option{Values: map[string][]string{}}
	for _, id := range models {
		model.Values[id] = []string{"--model", id}
	}
	context.Configuration = map[string]config.Harness{"claude-code": {Flags: []string{}, Options: map[string]config.Option{"model": model, "effort": {Values: map[string][]string{"high": {"--effort", "high"}}}}}}
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

func TestARequestPickingAModelItsHarnessGivesNoFlagForIsGivenBackSoNoSessionRunsAnotherModel(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Options = map[string]string{"model": "claude-opus-5"}
	context := withModels(aContext(request), "claude-opus-5")
	context.Configuration = map[string]config.Harness{"claude-code": {Flags: []string{}, Options: map[string]config.Option{"model": {Values: map[string][]string{"claude-opus-5": {}}}}}}

	next, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "options.model: claude-code gives no flag for the model claude-opus-5"})
	if len(next.Entries) != 0 {
		t.Errorf("entries = %+v, want none", next.Entries)
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

func TestARequestPickingAModelTheHarnessDoesNotOfferIsToConfirmItsHarnessAgain(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Options = map[string]string{"model": "claude-sonnet-5"}

	got := ModelsToConfirm(Empty(), withModels(aContext(request), "claude-opus-5"))

	if want := []Confirmation{{ShipID: scout, SettingsVersion: 1, Harness: "claude-code"}}; !slices.Equal(got, want) {
		t.Errorf("ModelsToConfirm() = %v, want %v", got, want)
	}
}

func TestARequestPickingAModelWhileTheHarnessOffersNoModelIsToConfirmItsHarnessAgain(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Options = map[string]string{"model": "claude-sonnet-5"}
	context := aContext(request)
	context.Options = map[string]map[string][]string{"claude-code": {"effort": {"high"}}}

	got := ModelsToConfirm(Empty(), context)

	if want := []Confirmation{{ShipID: scout, SettingsVersion: 1, Harness: "claude-code"}}; !slices.Equal(got, want) {
		t.Errorf("ModelsToConfirm() = %v, want %v", got, want)
	}
}

func TestARequestPickingNoModelWhileTheHarnessOffersNoModelIsNotToConfirm(t *testing.T) {
	request := aRequest(scout)
	context := aContext(request)
	context.Options = map[string]map[string][]string{"claude-code": {"effort": {"high"}}}

	if got := ModelsToConfirm(Empty(), context); len(got) != 0 {
		t.Errorf("ModelsToConfirm() = %v, want none", got)
	}
}

func TestARequestPickingAnOfferedModelOrOneGivenBackOrFinalIsNotToConfirm(t *testing.T) {
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
