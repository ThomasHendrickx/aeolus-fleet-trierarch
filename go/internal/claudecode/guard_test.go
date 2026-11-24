package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// aGuardedHarness is a harness whose sessions get the guard: its program and the state folder's ships directory.
func aGuardedHarness(t *testing.T) (Harness, *aRuntime) {
	t.Helper()
	harness, running, _ := aHarness(t)
	harness.Program = "/opt/aeolus trierarch/aeolus-trierarch"
	harness.Ships = t.TempDir()
	return harness, running
}

func TestEverySessionStartsWithTheGuardHookInItsSettings(t *testing.T) {
	harness, running := aGuardedHarness(t)
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	settings := filepath.Join(harness.Ships, scout, "guard", "settings.json")
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
		"hooks":   []any{map[string]any{"type": "command", "command": `'/opt/aeolus trierarch/aeolus-trierarch' guard check --ship ` + scout}},
	}}}}
	if got, _ := json.Marshal(written); string(got) != mustJSON(t, want) {
		t.Fatalf("settings = %s, want %s", got, mustJSON(t, want))
	}
	if info, err := os.Stat(settings); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("settings mode = %v, %v, want 600", info, err)
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
