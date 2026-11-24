package runpass

import (
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// guardedHarness is the harness whose settings disable the guard as its problem says.
type guardedHarness struct {
	*aHarness
	problem string
}

func (h guardedHarness) GuardProblem(reconciler.Entry) string { return h.problem }

const hooksOff = "guard disabled by settings: /home/.claude/settings.json"

func TestACrewWhoseSettingsDisableTheGuardIsGivenBackBeforeItRegisters(t *testing.T) {
	pass := aRunPass(t)
	pass.pass.Harnesses = map[string]Harness{"claude-code": guardedHarness{aHarness: pass.harness, problem: hooksOff}}
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
	pass := aRunPass(t)
	guarded := &guardedHarness{aHarness: pass.harness}
	pass.pass.Harnesses = map[string]Harness{"claude-code": guarded}
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
