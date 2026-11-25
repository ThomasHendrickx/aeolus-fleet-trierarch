package runpass

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

// guardedHarness is the harness whose sessions start guarded, its settings disabling the guard as its problem says.
type guardedHarness struct {
	*aHarness
	problem string
}

func (h guardedHarness) GuardProblem(context.Context, reconciler.Entry) (string, error) {
	return h.problem, nil
}

func (guardedHarness) IsGuarded() bool { return true }

// someGuardRules are the settings versions whose rules are kept, by ship.
type someGuardRules map[string]int

func (r someGuardRules) KeptVersion(_ context.Context, shipID string) (int, bool, error) {
	version, ok := r[shipID]
	return version, ok, nil
}

func (r someGuardRules) Forget(_ context.Context, shipID string) error {
	delete(r, shipID)
	return nil
}

// aGuardedPass is a pass whose harness starts its sessions guarded, scout's rules kept at the versions given.
func aGuardedPass(t *testing.T, rules someGuardRules) (*aPass, *guardedHarness) {
	t.Helper()
	pass := aRunPass(t)
	guarded := &guardedHarness{aHarness: pass.harness}
	pass.pass.Harnesses = map[string]Harness{"claude-code": guarded}
	pass.pass.GuardRules = rules
	return pass, guarded
}

func registered(calls []string) bool {
	return slices.ContainsFunc(calls, func(call string) bool { return strings.HasPrefix(call, "register") })
}

func TestACrewWaitsForTheRulesOfItsSettingsVersionBeforeItRegisters(t *testing.T) {
	for name, rules := range map[string]someGuardRules{"none kept": {}, "an older version's": {scout: 0}} {
		t.Run(name, func(t *testing.T) {
			pass, _ := aGuardedPass(t, rules)
			pass.fleet.requests = []reconciler.Request{aRequest("")}

			pass.run(t)
			pass.pass.Now = func() time.Time { return now.Add(10*time.Minute - time.Second) }
			pass.run(t)

			if registered(pass.fleet.calls) || len(pass.harness.launches) != 0 || slices.ContainsFunc(pass.fleet.calls, func(call string) bool { return strings.HasPrefix(call, "giveBack") }) {
				t.Fatalf("calls %q, launches %d, want it waiting", pass.fleet.calls, len(pass.harness.launches))
			}
		})
	}
}

func TestACrewStartsOnceTheRulesOfItsSettingsVersionArrive(t *testing.T) {
	rules := someGuardRules{}
	pass, _ := aGuardedPass(t, rules)
	pass.fleet.requests = []reconciler.Request{aRequest("")}
	pass.run(t)

	rules[scout] = 1
	pass.run(t)

	if !registered(pass.fleet.calls) || len(pass.harness.launches) != 1 {
		t.Fatalf("calls %q, launches %d, want it crewed", pass.fleet.calls, len(pass.harness.launches))
	}
}

func TestACrewWhoseRulesDidNotArriveInTenMinutesIsGivenBack(t *testing.T) {
	pass, _ := aGuardedPass(t, someGuardRules{})
	pass.fleet.requests = []reconciler.Request{aRequest("")}
	pass.run(t)

	pass.pass.Now = func() time.Time { return now.Add(10 * time.Minute) }
	pass.run(t)

	if !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: guard rules did not arrive") || registered(pass.fleet.calls) || len(pass.harness.launches) != 0 {
		t.Fatalf("calls %q, launches %d, want it given back before it registers", pass.fleet.calls, len(pass.harness.launches))
	}
}

func TestASessionStartsAgainOnlyWithTheRulesOfItsSettingsVersion(t *testing.T) {
	rules := someGuardRules{scout: 1}
	pass, _ := aGuardedPass(t, rules)
	pass.crewed(t)
	delete(rules, scout)
	pass.sessions.observed = nil

	pass.run(t)
	pass.fleet.requests = []reconciler.Request{aRequest("restarting")}
	pass.run(t)

	if len(pass.harness.launches) != 1 {
		t.Fatalf("launches %d, want no start again without its rules", len(pass.harness.launches))
	}
}

func givenBack(calls []string, reason string) bool {
	return slices.Contains(calls, "giveBack "+scout+" 1 mac-mini: "+reason)
}

func TestAnIdleSessionAnotherVersionStartedStartsAgainOnlyWithTheRulesOfItsSettingsVersion(t *testing.T) {
	rules := someGuardRules{scout: 1}
	pass, _ := aGuardedPass(t, rules)
	pass.crewed(t)
	delete(rules, scout)
	pass.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "running", IsOtherVersion: true}}
	pass.harness.turns[folder] = reconciler.TurnIdle

	pass.run(t)

	if len(pass.harness.launches) != 1 || len(pass.harness.died) != 0 {
		t.Fatalf("launches %d, died %q, want no start again without its rules", len(pass.harness.launches), pass.harness.died)
	}
}

func TestASessionWhoseRulesDidNotArriveWithinTenMinutesOfItsStartAgainIsGivenBack(t *testing.T) {
	for name, observed := range map[string][]sessions.Observed{
		"after its session ended":          nil,
		"after another version started it": {{ShipID: scout, Status: "running", IsOtherVersion: true}},
	} {
		t.Run(name, func(t *testing.T) {
			rules := someGuardRules{scout: 1}
			pass, _ := aGuardedPass(t, rules)
			pass.crewed(t)
			delete(rules, scout)
			pass.sessions.observed = observed
			pass.harness.turns[folder] = reconciler.TurnIdle
			pass.run(t)
			pass.pass.Now = func() time.Time { return now.Add(10*time.Minute - time.Second) }
			pass.run(t)
			if givenBack(pass.fleet.calls, "guard rules did not arrive") {
				t.Fatalf("calls %q, want it waiting within ten minutes", pass.fleet.calls)
			}

			pass.pass.Now = func() time.Time { return now.Add(10 * time.Minute) }
			pass.run(t)
			pass.run(t)

			if !givenBack(pass.fleet.calls, "guard rules did not arrive") || len(pass.harness.launches) != 1 {
				t.Fatalf("calls %q, launches %d, want it given back, never started again", pass.fleet.calls, len(pass.harness.launches))
			}
		})
	}
}

func TestAShipCrewedAgainInAFreshShipFolderWhoseSettingsDisableTheGuardIsGivenBack(t *testing.T) {
	for name, recover := range map[string]func(*aPass){
		"its ship's folder removed by hand": func(pass *aPass) {
			pass.workspace.gone = map[string]bool{pass.store.state.Entries[scout].ShipFolder: true}
		},
		"crewed before the ship folder layout": func(pass *aPass) { pass.crewedInTheOldLayout(t) },
	} {
		t.Run(name, func(t *testing.T) {
			pass, guarded := aGuardedPass(t, someGuardRules{scout: 1})
			pass.crewed(t)
			recover(pass)
			pass.fleet.calls = nil
			guarded.problem = hooksOff

			pass.run(t)
			pass.run(t)

			if !givenBack(pass.fleet.calls, hooksOff) || len(pass.harness.launches) != 1 {
				t.Fatalf("calls %q, launches %d, want it given back, never started", pass.fleet.calls, len(pass.harness.launches))
			}
		})
	}
}

func TestAShipCrewedAgainInAFreshShipFolderWaitsForTheRulesOfItsSettingsVersion(t *testing.T) {
	rules := someGuardRules{scout: 1}
	pass, _ := aGuardedPass(t, rules)
	pass.crewed(t)
	pass.workspace.gone = map[string]bool{pass.store.state.Entries[scout].ShipFolder: true}
	delete(rules, scout)

	pass.run(t)
	pass.run(t)

	if len(pass.harness.launches) != 1 {
		t.Fatalf("launches %d, want no start in the fresh ship folder without its rules", len(pass.harness.launches))
	}
}

func TestAHarnessWithoutAGuardStartsWithoutRules(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.GuardRules = someGuardRules{}
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if len(pass.harness.launches) != 1 {
		t.Fatalf("launches %d, want it started", len(pass.harness.launches))
	}
}

const hooksOff = "guard disabled by settings: /home/.claude/settings.json"

func TestACrewWhoseSettingsDisableTheGuardIsGivenBackBeforeItRegisters(t *testing.T) {
	pass, guarded := aGuardedPass(t, someGuardRules{scout: 1})
	guarded.problem = hooksOff
	pass.fleet.requests = []reconciler.Request{aRequest("")}

	pass.run(t)

	if !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: "+hooksOff) || slices.ContainsFunc(pass.fleet.calls, func(call string) bool { return strings.HasPrefix(call, "register") }) || len(pass.harness.launches) != 0 {
		t.Fatalf("calls %q, launches %d, want given back before it registers", pass.fleet.calls, len(pass.harness.launches))
	}
	if len(pass.store.state.Entries) != 0 {
		t.Fatalf("entries %+v, want none", pass.store.state.Entries)
	}
}

func TestASessionWhoseSettingsDisableTheGuardIsGivenBackInsteadOfStartedAgain(t *testing.T) {
	pass, guarded := aGuardedPass(t, someGuardRules{scout: 1})
	pass.crewed(t)
	guarded.problem = hooksOff
	pass.sessions.observed = nil

	pass.run(t)
	pass.fleet.requests = []reconciler.Request{aRequest("restarting")}
	pass.run(t)

	if len(pass.harness.launches) != 1 || !slices.Contains(pass.fleet.calls, "giveBack "+scout+" 1 mac-mini: "+hooksOff) {
		t.Fatalf("launches %d, calls %q, want no start again and the request given back", len(pass.harness.launches), pass.fleet.calls)
	}
}

func TestAReleaseForgetsTheShipsGuardFolder(t *testing.T) {
	rules := someGuardRules{scout: 1}
	pass, _ := aGuardedPass(t, rules)
	pass.crewed(t)
	pass.fleet.requests = []reconciler.Request{aRequest("releasing")}

	pass.run(t)

	if _, ok := rules[scout]; ok || len(pass.store.state.Entries) != 0 {
		t.Fatalf("rules %v, entries %+v, want the guard folder forgotten with the request", rules, pass.store.state.Entries)
	}
}

// stalledGuardRules are rules whose every read stalls until its context ends.
type stalledGuardRules struct{}

func (stalledGuardRules) KeptVersion(ctx context.Context, _ string) (int, bool, error) {
	<-ctx.Done()
	return 0, false, ctx.Err()
}

func (stalledGuardRules) Forget(ctx context.Context, _ string) error {
	<-ctx.Done()
	return ctx.Err()
}

func TestAStalledGuardRulesReadHoldsThePassNoLongerThanItsContext(t *testing.T) {
	pass, _ := aGuardedPass(t, someGuardRules{})
	pass.pass.GuardRules = stalledGuardRules{}
	pass.fleet.requests = []reconciler.Request{aRequest("")}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	ended := make(chan error, 1)

	go func() { ended <- pass.pass.Run(ctx) }()

	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("the pass still ran 3 seconds after its context ended")
	}
	if len(pass.harness.launches) != 0 || registered(pass.fleet.calls) {
		t.Fatalf("calls %q, launches %d, want nothing started without its rules read", pass.fleet.calls, len(pass.harness.launches))
	}
}

type proofPendingHarness struct {
	*aHarness
	hasSets bool
}

func (proofPendingHarness) IsGuarded() bool       { return false }
func (proofPendingHarness) NeedsGuardRules() bool { return true }
func (h proofPendingHarness) GuardProblem(context.Context, reconciler.Entry) (string, error) {
	if h.hasSets {
		return "guard disabled: Codex version has no proof", nil
	}
	return "", nil
}

func TestUnprovenCodexStartsOnlyAfterItKnowsTheAssignmentHasNoRuleSets(t *testing.T) {
	for _, hasSets := range []bool{false, true} {
		pass := aRunPass(t)
		pass.pass.Harnesses = map[string]Harness{"claude-code": proofPendingHarness{aHarness: pass.harness, hasSets: hasSets}}
		rules := someGuardRules{}
		pass.pass.GuardRules = rules
		pass.fleet.requests = []reconciler.Request{aRequest("")}
		pass.run(t)
		if registered(pass.fleet.calls) {
			t.Fatalf("calls before rules arrive = %q, want no register", pass.fleet.calls)
		}
		rules[scout] = 1
		pass.run(t)
		if hasSets && !givenBack(pass.fleet.calls, "guard disabled: Codex version has no proof") {
			t.Fatalf("calls = %q, want rule-bearing assignment given back", pass.fleet.calls)
		}
		if got := registered(pass.fleet.calls); got == hasSets {
			t.Fatalf("registered = %t with rule sets present %t", got, hasSets)
		}
	}
}
