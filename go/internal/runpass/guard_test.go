package runpass

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// guardedHarness is the harness whose sessions start guarded, its settings disabling the guard as its problem says.
type guardedHarness struct {
	*aHarness
	problem string
}

func (h guardedHarness) GuardProblem(reconciler.Entry) string { return h.problem }

func (guardedHarness) IsGuarded() bool { return true }

// someGuardRules are the settings versions whose rules are kept, by ship.
type someGuardRules map[string]int

func (r someGuardRules) KeptVersion(shipID string) (int, bool, error) {
	version, ok := r[shipID]
	return version, ok, nil
}

func (r someGuardRules) Forget(shipID string) error {
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
