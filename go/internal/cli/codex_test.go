package cli

import (
	"errors"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// aCodex keeps the folders it trusts and the folders it trusted the aeolus-fleet plugin's hooks from, or fails with the error given.
type aCodex struct {
	trusted   []string
	hooksFrom []string
	err       error
}

func (c *aCodex) Trust(folders []string) error {
	if c.err != nil {
		return c.err
	}
	c.trusted = append(c.trusted, folders...)
	return nil
}

func (c *aCodex) TrustAeolusHooks(folder string) ([]string, error) {
	if c.err != nil {
		return nil, c.err
	}
	c.hooksFrom = append(c.hooksFrom, folder)
	return []string{"aeolus-fleet@aeolus-fleet:session-start"}, nil
}

func withCodex(machine *aMachine, isSignedIn bool) *aCodex {
	codex := &aCodex{}
	machine.init.IsCodexInstalled, machine.init.IsCodexSignedIn, machine.init.Codex = true, isSignedIn, codex
	return codex
}

func aConfigurationOfferingCodex(t *testing.T, machine *aMachine) {
	t.Helper()
	configuration := config.Initial()
	configuration.Harnesses["codex"] = config.Harness{Flags: []string{}, Options: map[string]config.Option{}}
	configuration.Repositories["aeolus-fleet"] = config.Repository{Path: "/src/aeolus-fleet"}
	configuration.Folders["notes"] = config.Folder{Path: "/notes"}
	if err := os.MkdirAll(machine.init.Paths.Home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := config.Write(machine.init.Paths.Config, configuration); err != nil {
		t.Fatal(err)
	}
}

func TestInitOffersCodexWhereCodexIsInstalled(t *testing.T) {
	machine := newMachine(t)
	withCodex(machine, true)

	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}

	written, err := config.Load(machine.init.Paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	codex, ok := written.Harnesses["codex"]
	if _, hasClaudeCode := written.Harnesses["claude-code"]; !ok || !hasClaudeCode || len(codex.Flags) != 0 || len(codex.Options) != 0 {
		t.Fatalf("harnesses %+v, want claude-code and codex with no flags or options", written.Harnesses)
	}
}

func TestInitTrustsEachPlaceAndTheAeolusPluginsHooksInCodexWhereTheConfigurationOffersIt(t *testing.T) {
	machine := newMachine(t)
	codex := withCodex(machine, true)
	aConfigurationOfferingCodex(t, machine)

	report, err := machine.init.Run(setupLine())

	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"/src/aeolus-fleet", "/notes"}; !slices.Equal(codex.trusted, want) || !slices.Equal(report.CodexTrusted, want) {
		t.Fatalf("Codex trusted %q, report %q, want %q", codex.trusted, report.CodexTrusted, want)
	}
	if want := []string{machine.init.Paths.Ships}; !slices.Equal(codex.hooksFrom, want) || !slices.Equal(report.CodexHooksTrusted, []string{"aeolus-fleet@aeolus-fleet:session-start"}) {
		t.Fatalf("hooks trusted from %q, report %q, want from %q", codex.hooksFrom, report.CodexHooksTrusted, want)
	}
}

func TestInitGoesOnAndSaysSoWhenCodexCannotBeSetUp(t *testing.T) {
	machine := newMachine(t)
	codex := withCodex(machine, true)
	codex.err = errors.New("codex app-server ended before it answered initialize")
	aConfigurationOfferingCodex(t, machine)

	report, err := machine.init.Run(setupLine())

	if err != nil {
		t.Fatalf("init = %v, want it to go on", err)
	}
	want := "Codex is not set up: codex app-server ended before it answered initialize. A Codex session waits on its trust questions until you run aeolus-trierarch init again."
	if !slices.Contains(report.Said, want) || len(report.CodexTrusted) != 0 {
		t.Fatalf("said %q, Codex trusted %q, want %q said", report.Said, report.CodexTrusted, want)
	}
}

func TestInitTakesAMachineWhereCodexAloneIsInstalledAndSignedIn(t *testing.T) {
	machine := newMachine(t)
	machine.init.IsClaudeCodeInstalled, machine.init.IsClaudeCodeSignedIn = false, false
	withCodex(machine, true)

	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatalf("init = %v, want a machine with Codex alone taken", err)
	}
}

func TestInitRefusesBeforeItRegistersAnythingWhereNeitherHarnessIsSignedIn(t *testing.T) {
	machine := newMachine(t)
	machine.init.IsClaudeCodeSignedIn = false
	withCodex(machine, false)

	_, err := machine.init.Run(setupLine())

	want := "Claude Code (run `claude` and sign in) and Codex (run `codex login`) are installed but not signed in"
	if err == nil || !strings.Contains(err.Error(), want) || len(machine.fleet.registered) != 0 {
		t.Fatalf("init = %v, registered %q, want refused with %q", err, machine.fleet.registered, want)
	}
}

func TestAddRepositoryTrustsItInCodexWhereTheConfigurationOffersCodex(t *testing.T) {
	machine, _, _ := aMain(t)
	codex := &aCodex{}
	machine.IsCodexInstalled, machine.IsCodexSignedIn = func() bool { return true }, func() bool { return true }
	machine.Codex = func() Codex { return codex }
	Main(setupWords(), machine)
	repository := aCheckout(t)

	output, code := Main([]string{"add", "repository", "aeolus-fleet", repository, "--json"}, machine)

	if code != 0 || !slices.Equal(codex.trusted, []string{repository}) || !strings.Contains(output, `"codex"`) {
		t.Fatalf("answered %s, %d, Codex trusted %q, want it trusted by codex", output, code, codex.trusted)
	}
}

func TestAddRepositorySaysWhenCodexDoesNotTrustIt(t *testing.T) {
	machine, _, _ := aMain(t)
	codex := &aCodex{err: errors.New("codex is not installed, or codex does not run")}
	machine.IsCodexInstalled, machine.IsCodexSignedIn = func() bool { return true }, func() bool { return true }
	machine.Codex = func() Codex { return codex }
	Main(setupWords(), machine)

	output, code := Main([]string{"add", "repository", "aeolus-fleet", aCheckout(t)}, machine)

	if want := "Codex does not trust it: codex is not installed, or codex does not run. The trierarch offers it once every harness trusts it: run this again when Codex runs."; code != 0 || !strings.Contains(output, want) {
		t.Fatalf("answered %q, %d, want %q", output, code, want)
	}
}
