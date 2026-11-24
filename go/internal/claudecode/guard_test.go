package claudecode

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// aGuardedHarness is a harness whose sessions get the guard: its program and the state folder's ships directory.
func aGuardedHarness(t *testing.T) (Harness, *aRuntime) {
	t.Helper()
	harness, running, _ := aHarness(t)
	harness.Program = "/opt/aeolus trierarch/aeolus-trierarch"
	return harness, running
}

func TestEverySessionStartsWithTheGuardHookInItsSettings(t *testing.T) {
	harness, running := aGuardedHarness(t)
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	settings := filepath.Join(harness.Guards, scout, "settings.json")
	command := running.started[0].Command
	at := slices.Index(command, "--settings")
	if at < 0 || at+1 >= len(command) || command[at+1] != settings {
		t.Fatalf("command %q, want --settings %s", command, settings)
	}
	text, err := os.ReadFile(settings)
	if err != nil {
		t.Fatal(err)
	}
	var written map[string]any
	if err := json.Unmarshal(text, &written); err != nil {
		t.Fatalf("settings %s is no JSON: %v", text, err)
	}
	want := map[string]any{"hooks": map[string]any{"PreToolUse": []any{map[string]any{
		"matcher": "*",
		"hooks":   []any{map[string]any{"type": "command", "command": `'/opt/aeolus trierarch/aeolus-trierarch' guard check --ship ` + scout + ` || exit 2`, "timeout": 30}},
	}}}}
	if got, _ := json.Marshal(written); string(got) != mustJSON(t, want) {
		t.Fatalf("settings = %s, want %s", got, mustJSON(t, want))
	}
	if info, err := os.Stat(settings); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("settings mode = %v, %v, want 600", info, err)
	}
}

func TestTheGuardHookChecksWithTheConfigurationTheTrierarchRunsWith(t *testing.T) {
	harness, running := aGuardedHarness(t)
	harness.Config = "/etc/aeolus fleet/trierarch.json"
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	settings, _ := guardSettingsOf(t, running.started[0].Command)
	hook := settings["hooks"].(map[string]any)["PreToolUse"].([]any)[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)
	if want := `'/opt/aeolus trierarch/aeolus-trierarch' guard check --ship ` + scout + ` --config '/etc/aeolus fleet/trierarch.json' || exit 2`; hook["command"] != want {
		t.Fatalf("hook command = %q, want %q", hook["command"], want)
	}
}

func TestTheGuardSettingsComeBeforeTheMcpConfigurationWhichTakesEveryWordUpToTheNextFlag(t *testing.T) {
	harness, running := aGuardedHarness(t)
	entry := anEntry(t)

	if err := harness.Launch(entry, false, "launch-2"); err != nil {
		t.Fatal(err)
	}

	command := running.started[0].Command
	settings, mcp := slices.Index(command, "--settings"), slices.Index(command, "--mcp-config")
	if settings < 0 || (mcp >= 0 && settings > mcp) {
		t.Fatalf("command %q, want --settings before --mcp-config", command)
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

// withSettings writes the settings text to the file, its folder made.
// problemOf is why the entry's session cannot start guarded, its settings read.
func problemOf(t *testing.T, harness Harness, entry reconciler.Entry) string {
	t.Helper()
	problem, err := harness.GuardProblem(context.Background(), entry)
	if err != nil {
		t.Fatalf("GuardProblem: %v", err)
	}
	return problem
}

func withSettings(t *testing.T, file string, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestEverySettingsFileASessionLoadsThatDisablesHooksKeepsItFromStarting(t *testing.T) {
	for name, fileOf := range map[string]func(Harness, string) string{
		"user":    func(h Harness, _ string) string { return h.User },
		"project": func(_ Harness, folder string) string { return filepath.Join(folder, ".claude", "settings.json") },
		"local":   func(_ Harness, folder string) string { return filepath.Join(folder, ".claude", "settings.local.json") },
		"managed": func(h Harness, _ string) string { return filepath.Join(h.Managed, "managed-settings.json") },
		"managed drop-in": func(h Harness, _ string) string {
			return filepath.Join(h.Managed, "managed-settings.d", "50-hooks.json")
		},
		"the configuration": func(h Harness, folder string) string { return filepath.Join(folder, "configured.json") },
	} {
		t.Run(name, func(t *testing.T) {
			harness, running := aGuardedHarness(t)
			harness.Settings = func() config.Harness {
				return config.Harness{Flags: []string{"--settings", "configured.json"}, Options: map[string]config.Option{}}
			}
			entry := anEntry(t)
			file := fileOf(harness, entry.Folder)
			withSettings(t, file, `{"disableAllHooks":true}`)

			if got, want := problemOf(t, harness, entry), "guard disabled by settings: "+file; got != want {
				t.Fatalf("GuardProblem = %q, want %q", got, want)
			}
			if len(running.started) != 0 {
				t.Fatalf("started %+v, want nothing", running.started)
			}
		})
	}
}

func TestASessionOnTheHostThatKeepsItsShipHomeIsCheckedAgainstTheUserSettingsOfThatHome(t *testing.T) {
	harness, _ := aGuardedHarness(t)
	entry := anEntry(t)
	entry.ShipFolder = t.TempDir()
	home := filepath.Join(entry.ShipFolder, "home")
	shipPlugin := harness.Plugin
	shipPlugin.Data = filepath.Join(home, ".claude", "plugins", "data", plugin.DataFolder)
	shipPlugin.Crews = filepath.Join(home, ".aeolus", "crews", "claude-code")
	if err := shipPlugin.WriteIdentity(entry.Folder, anIdentity(), "crew-token"); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(home, ".claude", "settings.json")
	withSettings(t, file, `{"disableAllHooks":true}`)

	if got, want := problemOf(t, harness, entry), "guard disabled by settings: "+file; got != want {
		t.Fatalf("GuardProblem = %q, want %q", got, want)
	}
}

func TestSettingsThatCannotBeReadWithinTheContextKeepTheSessionFromStarting(t *testing.T) {
	harness, _ := aGuardedHarness(t)
	entry := anEntry(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if problem, err := harness.GuardProblem(ctx, entry); err == nil {
		t.Fatalf("GuardProblem = %q, nil, want its context's end", problem)
	}
}

func TestManagedSettingsThatAllowOnlyManagedHooksDisableTheGuard(t *testing.T) {
	harness, _ := aGuardedHarness(t)
	entry := anEntry(t)
	file := filepath.Join(harness.Managed, "managed-settings.json")
	withSettings(t, file, `{"allowManagedHooksOnly":true}`)

	if got, want := problemOf(t, harness, entry), "guard disabled by settings: "+file; got != want {
		t.Fatalf("GuardProblem = %q, want %q", got, want)
	}
}

func TestSettingsThatKeepHooksOrThatTheSessionDoesNotLoadLetItStart(t *testing.T) {
	harness, _ := aGuardedHarness(t)
	harness.Settings = func() config.Harness {
		return config.Harness{Flags: []string{"--setting-sources", "user"}, Options: map[string]config.Option{}}
	}
	entry := anEntry(t)
	withSettings(t, harness.User, `{"disableAllHooks":false,"permissions":{"defaultMode":"default"}}`)
	withSettings(t, filepath.Join(entry.Folder, ".claude", "settings.json"), `{"disableAllHooks":true}`)

	if got := problemOf(t, harness, entry); got != "" {
		t.Fatalf("GuardProblem = %q, want none", got)
	}
}

func TestASessionInAContainerStartsWithoutTheGuardWhichDoesNotReachItYet(t *testing.T) {
	harness, running := aGuardedHarness(t)
	harness.Homes = t.TempDir()
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if command := running.started[0].Command; slices.Contains(command, "--settings") {
		t.Fatalf("command %q, want no guard settings in a container", command)
	}
}

// guardSettingsOf are the guard settings the session started with, as JSON, and how often its command names --settings.
func guardSettingsOf(t *testing.T, command []string) (map[string]any, int) {
	t.Helper()
	named := 0
	file := ""
	for at, word := range command {
		if word == "--settings" && at+1 < len(command) {
			named, file = named+1, command[at+1]
		} else if strings.HasPrefix(word, "--settings=") {
			named++
		}
	}
	text, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]any
	if err := json.Unmarshal(text, &settings); err != nil {
		t.Fatalf("settings %s is no JSON: %v", text, err)
	}
	return settings, named
}

func TestAConfiguredSettingsFileStillAppliesWithTheGuardHookAdded(t *testing.T) {
	harness, running := aGuardedHarness(t)
	harness.Settings = func() config.Harness {
		return config.Harness{Flags: []string{"--model", "opus", "--settings", "configured.json"}, Options: map[string]config.Option{}}
	}
	entry := anEntry(t)
	withSettings(t, filepath.Join(entry.Folder, "configured.json"), `{"env":{"TEAM":"red"},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo own"}]}],"Stop":[{"hooks":[{"type":"command","command":"echo stop"}]}]}}`)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	settings, named := guardSettingsOf(t, running.started[0].Command)
	want := `{"env":{"TEAM":"red"},"hooks":{"PreToolUse":[{"hooks":[{"command":"echo own","type":"command"}],"matcher":"Bash"},{"hooks":[{"command":"'/opt/aeolus trierarch/aeolus-trierarch' guard check --ship ` + scout + ` || exit 2","timeout":30,"type":"command"}],"matcher":"*"}],"Stop":[{"hooks":[{"command":"echo stop","type":"command"}]}]}}`
	if got := mustJSON(t, settings); named != 1 || got != want {
		t.Fatalf("--settings named %d times, settings %s, want once and %s", named, got, want)
	}
}

func TestConfiguredInlineSettingsStillApplyWithTheGuardHookAdded(t *testing.T) {
	harness, running := aGuardedHarness(t)
	harness.Settings = func() config.Harness {
		return config.Harness{Flags: []string{`--settings={"env":{"TEAM":"blue"}}`}, Options: map[string]config.Option{}}
	}
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	settings, named := guardSettingsOf(t, running.started[0].Command)
	if env, _ := settings["env"].(map[string]any); named != 1 || env["TEAM"] != "blue" || settings["hooks"] == nil {
		t.Fatalf("--settings named %d times, settings %v, want once with the configured env and the guard hook", named, settings)
	}
}

func TestConfiguredSettingsThatAreNoJSONObjectStartNothing(t *testing.T) {
	harness, running := aGuardedHarness(t)
	harness.Settings = func() config.Harness {
		return config.Harness{Flags: []string{"--settings", "configured.json"}, Options: map[string]config.Option{}}
	}
	entry := anEntry(t)
	withSettings(t, filepath.Join(entry.Folder, "configured.json"), `[1]`)

	if err := harness.Launch(entry, true, "launch-1"); err == nil || len(running.started) != 0 {
		t.Fatalf("Launch = %v, started %d, want an error and nothing started", err, len(running.started))
	}
}

func TestSessionsOnTheHostStartGuardedAndInAContainerNotYet(t *testing.T) {
	harness, _ := aGuardedHarness(t)
	if !harness.IsGuarded() {
		t.Fatal("IsGuarded on the host = false, want true")
	}
	harness.Homes = t.TempDir()
	if harness.IsGuarded() {
		t.Fatal("IsGuarded in a container = true, want false")
	}
}
