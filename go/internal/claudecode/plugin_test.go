package claudecode

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// aClaude is a `claude` that keeps each command line it is given, lists the plugins named in its file, and fails every plugin command once told to.
type aClaude struct {
	folder string
}

func aClaudeWith(t *testing.T, installed ...string) aClaude {
	t.Helper()
	folder := t.TempDir()
	var listed []string
	for _, id := range installed {
		listed = append(listed, `{"id":"`+id+`"}`)
	}
	list := "[" + strings.Join(listed, ",") + "]"
	if err := os.WriteFile(filepath.Join(folder, "list.json"), []byte(list), 0o644); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
echo "$*" >> '` + folder + `/calls.txt'
if [ -e '` + folder + `/fails' ]; then echo 'Failed to reach the marketplace' >&2; exit 1; fi
if [ "$2" = list ]; then cat '` + folder + `/list.json'; fi
exit 0
`
	if err := os.WriteFile(filepath.Join(folder, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return aClaude{folder: folder}
}

func (c aClaude) calls(t *testing.T) []string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(c.folder, "calls.txt"))
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(text)), "\n")
}

func (c aClaude) update(t *testing.T, settings string, tag string) error {
	t.Helper()
	return PluginUpdate{Program: filepath.Join(c.folder, "claude"), Settings: settings}.Update(tag)
}

func TestPluginUpdatePointsTheMarketplaceAtTheReleaseTagAndUpdatesThePlugin(t *testing.T) {
	claude := aClaudeWith(t, "aeolus-fleet@aeolus-fleet")

	if err := claude.update(t, filepath.Join(t.TempDir(), "settings.json"), "v0.41.0"); err != nil {
		t.Fatal(err)
	}

	want := []string{
		"plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch#v0.41.0",
		"plugin marketplace update aeolus-fleet",
		"plugin list --json",
		"plugin update aeolus-fleet@aeolus-fleet",
	}
	if got := claude.calls(t); !reflect.DeepEqual(got, want) {
		t.Errorf("ran %q, want %q", got, want)
	}
}

func TestPluginUpdateInstallsAPluginClaudeCodeLacksAndUninstallsTheRenamedOne(t *testing.T) {
	claude := aClaudeWith(t, "aeolus@aeolus-fleet")

	if err := claude.update(t, filepath.Join(t.TempDir(), "settings.json"), "v0.41.0"); err != nil {
		t.Fatal(err)
	}

	calls := claude.calls(t)
	if !slices.Contains(calls, "plugin install aeolus-fleet@aeolus-fleet") || !slices.Contains(calls, "plugin uninstall aeolus@aeolus-fleet") {
		t.Errorf("ran %q, want the plugin installed and the renamed one uninstalled", calls)
	}
}

func TestPluginUpdateDropsTheMarketplaceTheSettingsDeclareKeepingEverythingElse(t *testing.T) {
	claude := aClaudeWith(t, "aeolus-fleet@aeolus-fleet")
	settings := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(settings, []byte(`{"model":"opus","extraKnownMarketplaces":{"aeolus-fleet":{"source":{"source":"github","repo":"ThomasHendrickx/aeolus-fleet-trierarch"}},"other":{"source":{"source":"github","repo":"o/p"}}}}`), 0o640); err != nil {
		t.Fatal(err)
	}

	if err := claude.update(t, settings, "v0.41.0"); err != nil {
		t.Fatal(err)
	}

	want := map[string]any{"model": "opus", "extraKnownMarketplaces": map[string]any{"other": map[string]any{"source": map[string]any{"source": "github", "repo": "o/p"}}}}
	if got := readJSON(t, settings); !reflect.DeepEqual(got, want) {
		t.Errorf("settings %v, want %v", got, want)
	}
	if info, _ := os.Stat(settings); info.Mode().Perm() != 0o640 {
		t.Errorf("mode %o, want 640", info.Mode().Perm())
	}
}

func TestPluginUpdateSaysTheCommandThatFailedAndWhatClaudeCodeSaid(t *testing.T) {
	claude := aClaudeWith(t, "aeolus-fleet@aeolus-fleet")
	if err := os.WriteFile(filepath.Join(claude.folder, "fails"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	err := claude.update(t, filepath.Join(t.TempDir(), "settings.json"), "v0.41.0")

	if err == nil || !strings.Contains(err.Error(), "plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch#v0.41.0 failed: Failed to reach the marketplace") {
		t.Fatalf("Update(claude failing) = %v, want the command and what it said", err)
	}
}

func TestPluginVersionIsTheVersionItsManifestSays(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".claude-plugin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".claude-plugin", "plugin.json"), []byte(`{"name":"aeolus-fleet","version":"0.41.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := PluginVersion(root); got != "0.41.0" {
		t.Errorf("PluginVersion(a manifest of 0.41.0) = %q, want 0.41.0", got)
	}
	if got := PluginVersion(t.TempDir()); got != "" {
		t.Errorf("PluginVersion(no manifest) = %q, want none", got)
	}
}
