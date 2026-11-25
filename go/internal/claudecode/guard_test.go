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
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/container"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
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
	if info, err := os.Stat(filepath.Dir(settings)); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("guard folder mode = %v, %v, want 700", info, err)
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
	withKeptRules(t, harness, noRuleSet)
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if command := running.started[0].Command; slices.Contains(command, "--settings") {
		t.Fatalf("command %q, want no guard settings in a container", command)
	}
}

// withKeptRules keeps the rules the fleet resolved for the ship, as the trierarch keeps them in its guard folder.
func withKeptRules(t *testing.T, harness Harness, text string) {
	t.Helper()
	if err := (guardfile.Store{Guards: harness.Guards}).Write(context.Background(), scout, []byte(text)); err != nil {
		t.Fatal(err)
	}
}

// aRuleSet are kept rules with one set, which a session may start only guarded.
const aRuleSet = `{"shipId":"` + scout + `","settingsVersion":0,"sets":[{"name":"no-publish"}]}`

func TestAContainerLaunchWhoseRulesCarryASetStartsNothingAsItCannotStartGuarded(t *testing.T) {
	for _, each := range []struct{ name, rules string }{
		{"a rule set", aRuleSet},
		{"rules it cannot read", `{"shipId":`},
	} {
		t.Run(each.name, func(t *testing.T) {
			harness, running := aGuardedHarness(t)
			harness.Homes = t.TempDir()
			withKeptRules(t, harness, each.rules)

			err := harness.Launch(anEntry(t), true, "launch-1")

			if err == nil || len(running.started) != 0 {
				t.Fatalf("Launch = %v, started %d, want an error and nothing started", err, len(running.started))
			}
		})
	}
}

func TestAContainerSessionWhoseRulesCarryASetIsGivenBackOnceTheyArrive(t *testing.T) {
	harness, _ := aGuardedHarness(t)
	harness.Homes = t.TempDir()
	if needs, ok := any(harness).(interface{ NeedsGuardRules() bool }); !ok || !needs.NeedsGuardRules() {
		t.Fatal("a container session starts before its rules arrive, want it to wait for them")
	}
	entry := anEntry(t)
	withKeptRules(t, harness, `{"shipId":"`+scout+`","settingsVersion":0,"sets":[]}`)
	if got := problemOf(t, harness, entry); got != "" {
		t.Fatalf("GuardProblem with no rule set = %q, want none", got)
	}

	withKeptRules(t, harness, aRuleSet)

	if got, want := problemOf(t, harness, entry), "guard disabled: Claude Code in a container is not guarded yet"; got != want {
		t.Fatalf("GuardProblem = %q, want %q", got, want)
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

// containerGuarding is a harness that can start its sessions in a container guarded, their calls checked on the host through the
// sockets of their ships under sockets (#631's limited rollout).
type containerGuarding interface {
	WithContainerGuard(sockets string) Harness
}

// aContainerGuardedHarness is a harness in containers whose sessions start guarded, its ships' sockets under the folder it answers, and
// a rule set kept for the ship: in a container, only a request that carries one starts guarded.
func aContainerGuardedHarness(t *testing.T) (Harness, *aRuntime, string) {
	t.Helper()
	harness, running, _, _ := inContainers(t)
	harness.Program = "/opt/aeolus trierarch/aeolus-trierarch"
	guarding, ok := any(harness).(containerGuarding)
	if !ok {
		t.Fatal("Claude Code cannot start a session in a container guarded, want it to check its calls on the host through its ship's socket")
	}
	sockets := filepath.Join(t.TempDir(), "o'brien sockets")
	harness = guarding.WithContainerGuard(sockets)
	harness.Runtime = aContainerRuntime{aRuntime: running, homes: harness.Homes, temp: t.TempDir()}
	withKeptRules(t, harness, aRuleSet)
	return harness, running, sockets
}

// aContainerRuntime runs each session in a container that sees the session's folder at its own path, its ship's home as
// /home/ubuntu and its ship's temp as /tmp.
type aContainerRuntime struct {
	*aRuntime
	homes string
	temp  string
}

func (r aContainerRuntime) Mounts(shipID string, folder string, shipFolder string) []container.Mount {
	return []container.Mount{
		{Host: folder, Container: folder},
		{Host: paths.ShipHome(r.homes, shipID, shipFolder), Container: "/home/ubuntu"},
		{Host: r.temp, Container: "/tmp"},
	}
}

// inlineSettingsOf are the settings the command line gives with --settings as JSON, and how often it names --settings.
func inlineSettingsOf(t *testing.T, command []string) (string, int) {
	t.Helper()
	named, text := 0, ""
	for at, word := range command {
		if word == "--settings" && at+1 < len(command) {
			named, text = named+1, command[at+1]
		} else if strings.HasPrefix(word, "--settings=") {
			named++
		}
	}
	var settings map[string]any
	if err := json.Unmarshal([]byte(text), &settings); err != nil {
		t.Fatalf("--settings %q is no JSON: %v", text, err)
	}
	return mustJSON(t, settings), named
}

// containerHook is the guard's hook in a container for a ship whose sockets folder is the one given: curl asks the ship's socket on
// the host, and the call runs only on its 200; its refusal goes to stderr, where Claude Code shows it.
func containerHook(sockets string) string {
	return `curl --silent --show-error --fail-with-body --max-time 10 --unix-socket '` + strings.ReplaceAll(sockets, "'", `'\''`) + `/fleet.sock' --data-binary @- http://localhost/guard/check >&2 || exit 2`
}

func TestInAContainerAGuardedSessionStartsWithTheHookThatAsksItsShipsSocketOnTheHost(t *testing.T) {
	harness, running, sockets := aContainerGuardedHarness(t)
	withKeptRules(t, harness, aRuleSet)

	if err := harness.Launch(anEntry(t), true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	settings, named := inlineSettingsOf(t, running.started[0].Command)
	want := mustJSON(t, map[string]any{"hooks": map[string]any{"PreToolUse": []any{map[string]any{
		"matcher": "*",
		"hooks":   []any{map[string]any{"type": "command", "command": containerHook(filepath.Join(sockets, scout)), "timeout": 30}},
	}}}})
	if named != 1 || settings != want {
		t.Fatalf("--settings named %d times, settings %s, want once and %s", named, settings, want)
	}
}

func TestInAContainerAGuardedSessionOfAShipFolderAsksTheSocketInIt(t *testing.T) {
	harness, running, _ := aContainerGuardedHarness(t)
	entry := anEntry(t)
	entry.ShipFolder = filepath.Join(t.TempDir(), scout)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	settings, _ := inlineSettingsOf(t, running.started[0].Command)
	if want := mustJSON(t, containerHook(filepath.Join(entry.ShipFolder, "sockets"))); !strings.Contains(settings, want) {
		t.Fatalf("settings %s, want the hook %s", settings, want)
	}
}

func TestInAContainerTheConfiguredSettingsStillApplyWithTheGuardHookAdded(t *testing.T) {
	harness, running, _ := aContainerGuardedHarness(t)
	harness.Settings = func() config.Harness {
		return config.Harness{Flags: []string{"--model", "opus", "--settings", "configured.json"}, Options: map[string]config.Option{}}
	}
	entry := anEntry(t)
	withSettings(t, filepath.Join(entry.Folder, "configured.json"), `{"env":{"TEAM":"red"}}`)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	settings, named := inlineSettingsOf(t, running.started[0].Command)
	if named != 1 || !strings.HasPrefix(settings, `{"env":{"TEAM":"red"},"hooks":{"PreToolUse":[{"hooks":[{"command":"curl `) {
		t.Fatalf("--settings named %d times, settings %s, want once with the configured env and the guard hook", named, settings)
	}
}

func TestInAContainerAGuardedSessionWritesNoSettingsFileTheContainerCannotSee(t *testing.T) {
	harness, _, _ := aContainerGuardedHarness(t)

	if err := harness.Launch(anEntry(t), true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(harness.Guards, scout, "settings.json")); err == nil {
		t.Fatal("the guard folder holds settings.json, want the settings on the command line, the guard folder out of the container's reach")
	}
}

func TestInAContainerAGuardedSessionIsGuardedAndStartsWhateverItsRulesCarry(t *testing.T) {
	harness, _, _ := aContainerGuardedHarness(t)
	if !harness.IsGuarded() {
		t.Fatal("IsGuarded in a guarded container = false, want true")
	}
	withKeptRules(t, harness, aRuleSet)

	if got := problemOf(t, harness, anEntry(t)); got != "" {
		t.Fatalf("GuardProblem with a rule set = %q, want none", got)
	}
}

func TestInAContainerSettingsTheSessionLoadsThatDisableHooksKeepItFromStarting(t *testing.T) {
	for name, fileOf := range map[string]func(Harness, reconciler.Entry) string{
		"the ship home's user settings": func(h Harness, e reconciler.Entry) string {
			return filepath.Join(h.Homes, scout, ".claude", "settings.json")
		},
		"project": func(_ Harness, e reconciler.Entry) string { return filepath.Join(e.Folder, ".claude", "settings.json") },
		"local": func(_ Harness, e reconciler.Entry) string {
			return filepath.Join(e.Folder, ".claude", "settings.local.json")
		},
	} {
		t.Run(name, func(t *testing.T) {
			harness, _, _ := aContainerGuardedHarness(t)
			entry := anEntry(t)
			file := fileOf(harness, entry)
			withSettings(t, file, `{"disableAllHooks":true}`)

			if got, want := problemOf(t, harness, entry), "guard disabled by settings: "+file; got != want {
				t.Fatalf("GuardProblem = %q, want %q", got, want)
			}
		})
	}
}

func TestInAContainerTheHostsUserSettingsDoNotDisableTheGuard(t *testing.T) {
	harness, _, _ := aContainerGuardedHarness(t)
	withSettings(t, harness.User, `{"disableAllHooks":true}`)

	if got := problemOf(t, harness, anEntry(t)); got != "" {
		t.Fatalf("GuardProblem = %q, want none: the container loads its ship home's settings, not the host user's", got)
	}
}

// noRuleSet are kept rules that carry no set.
const noRuleSet = `{"shipId":"` + scout + `","settingsVersion":0,"sets":[]}`

func TestInAContainerARequestWithoutARuleSetStartsWithoutTheGuardAsBefore(t *testing.T) {
	harness, running, _ := aContainerGuardedHarness(t)
	withKeptRules(t, harness, noRuleSet)

	if err := harness.Launch(anEntry(t), true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if command := running.started[0].Command; slices.Contains(command, "--settings") {
		t.Fatalf("command %q, want no guard settings for a request without a rule set", command)
	}
}

func TestInAContainerSettingsThatDisableHooksDoNotHoldBackARequestWithoutARuleSet(t *testing.T) {
	harness, _, _ := aContainerGuardedHarness(t)
	withKeptRules(t, harness, noRuleSet)
	entry := anEntry(t)
	withSettings(t, filepath.Join(entry.Folder, ".claude", "settings.json"), `{"disableAllHooks":true}`)

	if got := problemOf(t, harness, entry); got != "" {
		t.Fatalf("GuardProblem = %q, want none: a request without a rule set starts without the guard", got)
	}
}

func TestInAContainerAGuardedLaunchWhoseRulesCannotBeReadStartsNothing(t *testing.T) {
	harness, running, _ := aContainerGuardedHarness(t)
	withKeptRules(t, harness, `{"shipId":`)

	if err := harness.Launch(anEntry(t), true, "launch-1"); err == nil || len(running.started) != 0 {
		t.Fatalf("Launch = %v, started %d, want an error and nothing started", err, len(running.started))
	}
}

func TestInAContainerALaunchStartsNothingWithoutTheRulesOfItsRequestsOwnSettingsVersion(t *testing.T) {
	for _, each := range []struct{ name, rules string }{
		{"a newer resolution without a set", `{"shipId":"` + scout + `","settingsVersion":4,"sets":[]}`},
		{"an older resolution without a set", `{"shipId":"` + scout + `","settingsVersion":2,"sets":[]}`},
		{"no rules kept", ""},
	} {
		t.Run(each.name, func(t *testing.T) {
			harness, running, _ := aContainerGuardedHarness(t)
			if err := (guardfile.Store{Guards: harness.Guards}).Forget(context.Background(), scout); err != nil {
				t.Fatal(err)
			}
			if each.rules != "" {
				withKeptRules(t, harness, each.rules)
			}
			entry := anEntry(t)
			entry.SettingsVersion = 3

			err := harness.Launch(entry, true, "launch-1")

			if err == nil || len(running.started) != 0 {
				t.Fatalf("Launch of settings version 3 = %v, started %d, want an error and nothing started", err, len(running.started))
			}
		})
	}
}

func TestInAContainerTheRulesOfAnotherSettingsVersionDoNotSayARequestStartsUnguarded(t *testing.T) {
	harness, _, _ := aContainerGuardedHarness(t)
	withKeptRules(t, harness, `{"shipId":"`+scout+`","settingsVersion":4,"sets":[]}`)
	entry := anEntry(t)
	entry.SettingsVersion = 3
	withSettings(t, filepath.Join(entry.Folder, ".claude", "settings.json"), `{"disableAllHooks":true}`)

	if problem, err := harness.GuardProblem(context.Background(), entry); err == nil {
		t.Fatalf("GuardProblem of settings version 3 = %q, nil, want an error: the rules kept are of version 4", problem)
	}
}

// aLink is a symbolic link at the file to the target, as a session may plant one.
func aLink(t *testing.T, file string, target string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, file); err != nil {
		t.Fatal(err)
	}
}

// hooksOff is a settings file's name no host folder holds, which a container finds in a folder it mounts.
const hooksOff = "aeolus-guard-test-hooks-off.json"

func TestInAContainerSettingsThatDisableHooksAreReadWhereTheContainerFindsThem(t *testing.T) {
	for _, each := range []struct {
		name string
		// placed are the settings file the session loads, a link to a path in the container, and where the host keeps its target.
		placed func(Harness, aContainerRuntime, reconciler.Entry) (file string, target string, kept string)
	}{
		{"the ship home's user settings linked into its temp", func(h Harness, r aContainerRuntime, e reconciler.Entry) (string, string, string) {
			return filepath.Join(h.Homes, scout, ".claude", "settings.json"), "/tmp/" + hooksOff, filepath.Join(r.temp, hooksOff)
		}},
		{"the project settings linked into its home", func(h Harness, _ aContainerRuntime, e reconciler.Entry) (string, string, string) {
			return filepath.Join(e.Folder, ".claude", "settings.json"), "/home/ubuntu/" + hooksOff, filepath.Join(h.Homes, scout, hooksOff)
		}},
	} {
		t.Run(each.name, func(t *testing.T) {
			for _, host := range []string{"/tmp/" + hooksOff, "/home/ubuntu/" + hooksOff} {
				if _, err := os.Lstat(host); err == nil {
					t.Skipf("the host holds %s, which this test needs absent", host)
				}
			}
			harness, _, _ := aContainerGuardedHarness(t)
			entry := anEntry(t)
			runtime, _ := harness.Runtime.(aContainerRuntime)
			file, target, kept := each.placed(harness, runtime, entry)
			withSettings(t, kept, `{"disableAllHooks":true}`)
			aLink(t, file, target)

			if got, want := problemOf(t, harness, entry), "guard disabled by settings: "+file; got != want {
				t.Fatalf("GuardProblem = %q, want %q: the container reads %s at %s", got, want, file, target)
			}
		})
	}
}

func TestInAContainerSettingsLinkedOutOfTheFoldersItMountsHoldTheRequest(t *testing.T) {
	harness, _, _ := aContainerGuardedHarness(t)
	entry := anEntry(t)
	aLink(t, filepath.Join(entry.Folder, ".claude", "settings.local.json"), "/opt/"+hooksOff)

	if problem, err := harness.GuardProblem(context.Background(), entry); err == nil {
		t.Fatalf("GuardProblem = %q, %v, want an error: the guard cannot read the image's /opt/%s", problem, err, hooksOff)
	}
}
