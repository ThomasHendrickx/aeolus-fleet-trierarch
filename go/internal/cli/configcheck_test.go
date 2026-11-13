package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/container"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/prompt"
)

// aCheckedMachine is a set up machine whose configuration has Claude Code with a flag and an effort option, and Codex, and whose detection found two Claude Code models.
func aCheckedMachine(t *testing.T) (Machine, paths.Paths) {
	t.Helper()
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	at := paths.Of(machine.HomeDirectory, "")
	configuration := `{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{` +
		`"claude-code":{"flags":["--chrome","--permission-mode","plan"],"options":{"effort":{"values":{"low":["--effort","low"],"high":["--effort","high"]},"default":"high"}}},` +
		`"codex":{"flags":[],"options":{}}}}`
	if err := os.WriteFile(at.Config, []byte(configuration), 0o644); err != nil {
		t.Fatal(err)
	}
	model := detection.OptionOf([]string{"claude-sonnet-5", "claude-opus-5"}, "--model")
	model.Default = "claude-sonnet-5"
	confirmed := detectedAt
	found := detection.Detected{"claude-code": {Version: "2.1.306", DetectedAt: detectedAt, ConfirmedAt: &confirmed, PermissionModes: []string{"default", "manual", "plan"}, Options: map[string]config.Option{"model": model}}}
	if err := (detection.File{Path: at.Detected}).Save(found); err != nil {
		t.Fatal(err)
	}
	return machine, at
}

func TestConfigCheckSaysTheFlagsAndWhatEachHarnessLaunches(t *testing.T) {
	machine, at := aCheckedMachine(t)

	output, code := Main([]string{"config", "check"}, machine)

	const claude = "claude -p --input-format stream-json --output-format stream-json --verbose (adapter) --chrome --model claude-sonnet-5 --effort high (configuration) --permission-mode manual (adapter, when the Claude Code settings for the folder make plan the default mode) --disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode (adapter)"
	first := strings.ReplaceAll(prompt.First("<first prompt>"), "\n", `\n`)
	const codex = "codex exec"
	const codexFlags = " --json (adapter) --config=tools.experimental_request_user_input.enabled=false (adapter) --config=features.apps=false (adapter) -- "
	want := strings.Join([]string{
		"The configuration at " + at.Config + " fits.",
		"Sessions run on the host.",
		"Flags per harness (settings pick option values by name):",
		"claude-code: --chrome --permission-mode plan --model claude-sonnet-5 --effort high",
		"  model=claude-sonnet-5 (default): --model claude-sonnet-5",
		"  model=claude-opus-5: --model claude-opus-5",
		"  effort=low: --effort low",
		"  effort=high (default): --effort high",
		"codex: (no flags)",
		"",
		"What each harness launches, with the default options:",
		"claude-code:",
		"  first start: " + claude,
		"  restart: " + claude + " --continue (adapter)",
		"codex:",
		`  first start: ` + codex + codexFlags + `"` + first + `"`,
		`  restart: ` + codex + " resume --last" + codexFlags + `"` + strings.ReplaceAll(prompt.Wake("$aeolus-fleet-wake"), "\n", `\n`) + `"`,
	}, "\n")
	if code != 0 || output != want {
		t.Errorf("config check said %q, %d, want %q", output, code, want)
	}
}

func TestConfigCheckGivesTheEffectiveFlagsAndCommandLinesAsJSON(t *testing.T) {
	machine, at := aCheckedMachine(t)

	output, code := Main([]string{"config", "check", "--json"}, machine)

	got := decoded(t, output)
	harnesses, _ := got["harnesses"].(map[string]any)
	claude, _ := harnesses["claude-code"].(map[string]any)
	codex, _ := harnesses["codex"].(map[string]any)
	if code != 0 || got["path"] != at.Config || !reflect.DeepEqual(got["runtime"], map[string]any{"kind": "host"}) {
		t.Fatalf("config check answered %q, %d", output, code)
	}
	wantFlags := []any{"--chrome", "--permission-mode", "plan", "--model", "claude-sonnet-5", "--effort", "high"}
	if !reflect.DeepEqual(claude["flags"], wantFlags) {
		t.Errorf("claude-code flags %v, want %v", claude["flags"], wantFlags)
	}
	wantOptions := map[string]any{
		"model":  map[string]any{"claude-sonnet-5": []any{"--model", "claude-sonnet-5"}, "claude-opus-5": []any{"--model", "claude-opus-5"}},
		"effort": map[string]any{"low": []any{"--effort", "low"}, "high": []any{"--effort", "high"}},
	}
	if !reflect.DeepEqual(claude["options"], wantOptions) {
		t.Errorf("claude-code options %v, want %v", claude["options"], wantOptions)
	}
	wantAdapter := []any{map[string]any{"flag": "--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode", "when": "always"}, map[string]any{"flag": "--continue", "when": "restart"}}
	if !reflect.DeepEqual(claude["adapterFlags"], wantAdapter) {
		t.Errorf("claude-code adapter flags %v, want %v", claude["adapterFlags"], wantAdapter)
	}
	restart, _ := claude["restart"].([]any)
	last, _ := restart[len(restart)-1].(map[string]any)
	if !reflect.DeepEqual(last, map[string]any{"words": []any{"--continue"}, "source": "adapter"}) {
		t.Errorf("claude-code restart ends with %v", last)
	}
	if !reflect.DeepEqual(codex["flags"], []any{}) || !reflect.DeepEqual(codex["options"], map[string]any{}) {
		t.Errorf("codex flags %v and options %v, want none", codex["flags"], codex["options"])
	}
}

func TestConfigCheckSaysAHarnessItHasNoAdapterFor(t *testing.T) {
	machine, at := aCheckedMachine(t)
	if err := os.WriteFile(at.Config, []byte(`{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{"aider":{"flags":[],"options":{}}}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	output, code := Main([]string{"config", "check"}, machine)

	if !strings.HasSuffix(output, "aider: this trierarch has no adapter for it") || code != 0 {
		t.Errorf("config check said %q, %d", output, code)
	}
}

func TestConfigCheckSaysTheContainerRuntimeWithItsCapsAndTokenFile(t *testing.T) {
	machine, at := aCheckedMachine(t)
	if err := os.WriteFile(at.Config, []byte(`{"runtime":{"kind":"container","binary":"podman","memory":"4g","cpus":1.5},"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{"claude-code":{"flags":[],"options":{}}}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	output, _ := Main([]string{"config", "check"}, machine)

	want := "Sessions run in containers of podman, each capped at 4g of memory and 1.5 cpus, with the model token in " + at.ModelToken + "."
	if !strings.Contains(output, "\n"+want+"\n") {
		t.Errorf("config check said %q, want the line %q", output, want)
	}
}

func TestConfigCheckShowsNoOverrideWhereTheFlagsNameAPermissionMode(t *testing.T) {
	machine, at := aCheckedMachine(t)
	if err := os.WriteFile(at.Config, []byte(`{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{"claude-code":{"flags":["--dangerously-skip-permissions"],"options":{}}}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	output, _ := Main([]string{"config", "check"}, machine)

	if strings.Contains(output, "--permission-mode") {
		t.Errorf("config check said %q, want no permission mode override", output)
	}
}

func TestConfigCheckShowsTheOverrideWithoutWhenWhereTheManagedSettingsMakePlanTheDefault(t *testing.T) {
	machine, _ := aCheckedMachine(t)
	if err := os.MkdirAll(machine.ManagedSettings, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(machine.ManagedSettings, "managed-settings.json"), []byte(`{"permissions":{"defaultMode":"plan"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	output, _ := Main([]string{"config", "check"}, machine)

	if want := "--effort high (configuration) --permission-mode manual (adapter) --disallowedTools"; !strings.Contains(output, want) {
		t.Errorf("config check said %q, want it to contain %q", output, want)
	}
}

// aRuntime is the container runtime as the machine answers it: rootful when isRootful.
type aRuntime struct{ isRootful bool }

func (r aRuntime) Mode(string) container.Mode {
	if r.isRootful {
		return container.Rootful
	}
	return container.Rootless
}
func (aRuntime) Groups() ([]string, error)  { return []string{"user"}, nil }
func (aRuntime) IsModelTokenWritten() bool  { return true }
func (aRuntime) IsPastaMissing(string) bool { return false }

// inContainers sets the machine's configuration to run its sessions in containers of a runtime that runs rootful when isRootful.
func inContainers(t *testing.T, machine *Machine, at paths.Paths, isRootful bool) {
	t.Helper()
	configuration := `{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"runtime":{"kind":"container","binary":"podman","memory":"4g","cpus":2},"harnesses":{"claude-code":{"flags":[],"options":{}}}}`
	if err := os.WriteFile(at.Config, []byte(configuration), 0o644); err != nil {
		t.Fatal(err)
	}
	machine.ContainerHost = func(string) container.Host { return aRuntime{isRootful: isRootful} }
}

func TestConfigCheckRefusesARuntimeThatCannotHoldASessionToItsShip(t *testing.T) {
	machine, at := aCheckedMachine(t)
	inContainers(t, &machine, at, true)

	output, code := Main([]string{"config", "check"}, machine)

	want := "The configuration at " + at.Config + " cannot run its sessions in containers:\n  podman runs rootful: the container runtime runs rootless only, as the user that runs the trierarch"
	if code == 0 || !strings.Contains(output, want) {
		t.Fatalf("config check = %d %q, want a refusal %q", code, output, want)
	}
}

func TestConfigCheckSaysHowTheSessionsRunInContainers(t *testing.T) {
	machine, at := aCheckedMachine(t)
	inContainers(t, &machine, at, false)

	output, code := Main([]string{"config", "check"}, machine)

	want := "Sessions run in containers of podman, each capped at 4g of memory and 2 cpus, with the model token in " + at.ModelToken + "."
	if code != 0 || !strings.Contains(output, want) {
		t.Fatalf("config check = %d %q, want %q", code, output, want)
	}
}

func TestRunRefusesARuntimeThatCannotHoldASessionToItsShipBeforeAnyPass(t *testing.T) {
	machine, at := aCheckedMachine(t)
	inContainers(t, &machine, at, true)
	passes := 0
	machine.NewPass = func(paths.Paths, crew.File, config.Configuration) (func(isKeyCutOff bool) error, error) {
		passes++
		return func(bool) error { return nil }, nil
	}

	output, code := Main([]string{"run"}, machine)

	if code == 0 || passes != 0 || !strings.Contains(output, "cannot run its sessions in containers:\n  podman runs rootful") {
		t.Fatalf("run = %d %q after %d passes, want a refusal before any", code, output, passes)
	}
}

func TestAPlaceOfShipsWhereASocketPathPassesTheSystemsLimitIsRefusedNamingTheSettingToShorten(t *testing.T) {
	at := paths.Of("/home/me", "")
	// 106 bytes: past macOS's 104, under Linux's 108.
	place := "/home/me/" + strings.Repeat("p", 47)
	configuration := config.Configuration{ShipsRoot: place}
	socket := place + "/shp_00000000000000000000000000/sockets/fleet.sock"

	err := checkShipsPlace(at, configuration, "darwin")

	want := fmt.Sprintf("The configuration at /home/me/.aeolus/trierarch/config.json keeps the ships' files in %s, where a ship's socket path, as %s, is %d bytes, past the system's limit of 104: name a shorter place in shipsRoot", place, socket, len(socket))
	if err == nil || err.Error() != want {
		t.Fatalf("checkShipsPlace = %v, want %q", err, want)
	}
	if err := checkShipsPlace(at, configuration, "linux"); err != nil {
		t.Fatalf("on Linux, a %d-byte socket path is under its limit: %v", len(socket), err)
	}
	if err := checkShipsPlace(at, config.Configuration{}, "darwin"); err != nil {
		t.Fatalf("ships/ in the trierarch's folder: %v", err)
	}
}

func TestAConfigurationThatStillNamesWorktreeRootIsRefusedNamingItsNewName(t *testing.T) {
	at := paths.Of("/home/me", "")

	err := checkShipsPlace(at, config.Configuration{NamesWorktreeRoot: true}, "linux")

	want := "The configuration at /home/me/.aeolus/trierarch/config.json names worktreeRoot, which is now shipsRoot: rename the line to shipsRoot"
	if err == nil || err.Error() != want {
		t.Fatalf("checkShipsPlace = %v, want %q", err, want)
	}
}

func TestAConfigurationThatStillNamesCheckoutsIsRefusedNamingTheLineAndWhereSubRepositoriesComeFrom(t *testing.T) {
	at := paths.Of("/home/me", "")

	err := checkNoCheckouts(at, config.Configuration{NamesCheckouts: []string{"aeolus-company", "other"}})

	want := "The configuration at /home/me/.aeolus/trierarch/config.json names checkouts in repository aeolus-company: remove that line; a ship's sub-repositories come from its crew request"
	if err == nil || err.Error() != want {
		t.Fatalf("checkNoCheckouts = %v, want %q", err, want)
	}
	if err := checkNoCheckouts(at, config.Configuration{}); err != nil {
		t.Fatalf("a configuration naming none: %v", err)
	}
}
