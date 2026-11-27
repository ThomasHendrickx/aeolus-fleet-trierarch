package claudecode

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
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

func TestPluginUpdateKeepsAndNamesTheErrorWhenClaudeCodeCannotStart(t *testing.T) {
	err := PluginUpdate{Program: filepath.Join(t.TempDir(), "claude"), Settings: filepath.Join(t.TempDir(), "settings.json")}.Update("v0.41.0")

	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("error = %v, want the execution error kept for errors.Is", err)
	}
	if !strings.Contains(err.Error(), "claude") {
		t.Errorf("error %q does not name the harness", err)
	}
}

func TestPluginUpdateKeepsTheClaudeCachePathUntilTheSessionExits(t *testing.T) {
	for _, test := range []struct {
		name         string
		age          time.Duration
		hasUseMarker bool
	}{
		{"folder timestamp changes during downgrade", time.Hour, false},
		{"running session keeps its original directory", 10 * time.Second, false},
		{"live usage marker without a matching process name", 0, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			checkClaudeDowngrade(t, test.age, test.hasUseMarker)
		})
	}
}

func checkClaudeDowngrade(t *testing.T, age time.Duration, hasUseMarker bool) {
	t.Helper()
	claude := aClaudeWith(t, "aeolus-fleet@aeolus-fleet")
	settings := filepath.Join(claude.folder, "settings.json")
	plugins := filepath.Join(claude.folder, "plugins")
	cache := filepath.Join(plugins, "cache", "aeolus-fleet", "aeolus-fleet")
	older, newer := filepath.Join(cache, "0.41.0"), filepath.Join(cache, "0.42.0")
	for _, root := range []string{older, newer} {
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	hook := filepath.Join(newer, "hook")
	if err := os.WriteFile(hook, []byte("newer hook"), 0o600); err != nil {
		t.Fatal(err)
	}
	registry := filepath.Join(plugins, "installed_plugins.json")
	for index, root := range []string{newer, older} {
		content := fmt.Sprintf(`{"plugins":{"aeolus-fleet@aeolus-fleet":[{"scope":"user","installPath":%q}]}}`, root)
		if err := os.WriteFile(filepath.Join(claude.folder, fmt.Sprintf("registry-%d", index)), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	program := filepath.Join(claude.folder, "claude")
	script := fmt.Sprintf(`#!/bin/sh
case "$2" in
  list) cat %q ;;
  update)
    cp %q %q &&
    touch %q
    ;;
esac
`, filepath.Join(claude.folder, "list.json"), filepath.Join(claude.folder, "registry-1"), registry, filepath.Join(newer, ".orphaned_at"))
	if err := os.WriteFile(program, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	initial, err := os.ReadFile(filepath.Join(claude.folder, "registry-0"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(registry, initial, 0o600); err != nil {
		t.Fatal(err)
	}
	var starts []time.Time
	var marker string
	if hasUseMarker {
		markers := filepath.Join(newer, ".in_use")
		if err := os.Mkdir(markers, 0o700); err != nil {
			t.Fatal(err)
		}
		marker = filepath.Join(markers, strconv.Itoa(os.Getpid()))
		if err := os.WriteFile(marker, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	} else {
		starts = []time.Time{time.Now().Add(-age)}
	}
	installedAt := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(newer, installedAt, installedAt); err != nil {
		t.Fatal(err)
	}
	update := PluginUpdate{Program: program, Settings: settings, ProcessStarts: func() ([]time.Time, error) {
		return starts, nil
	}}
	if err := update.Update("v0.41.0"); err != nil {
		t.Fatal(err)
	}
	if got := plugin.ClaudeUserInstall(plugins); got != older {
		t.Fatalf("new Claude Code sessions select %q, want %q", got, older)
	}
	if err := update.RemoveUnusedVersions(); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(hook); err != nil || string(got) != "newer hook" {
		t.Fatalf("running session's hook = %q, %v, want newer hook", got, err)
	}
	if info, err := os.Lstat(newer); err != nil || !info.IsDir() {
		t.Fatalf("running session's cache path = %v, %v, want its original directory", info, err)
	}
	if hasUseMarker {
		if err := os.Remove(marker); err != nil {
			t.Fatal(err)
		}
	}
	starts = []time.Time{time.Now().Add(2 * time.Minute)}
	if err := update.RemoveUnusedVersions(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(newer); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stopped session's cache path: %v, want it removed", err)
	}
}

func TestZeroPluginUpdateUsesClaudeAndItsConfigDirectory(t *testing.T) {
	claude := aClaudeWith(t, "aeolus-fleet@aeolus-fleet")
	t.Setenv("PATH", claude.folder+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CLAUDE_CONFIG_DIR", claude.folder)
	settings := filepath.Join(claude.folder, "settings.json")
	if err := os.WriteFile(settings, []byte(`{"extraKnownMarketplaces":{"aeolus-fleet":{}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var update PluginUpdate
	if err := update.Update("v0.41.0"); err != nil {
		t.Fatal(err)
	}
	if err := update.RemoveUnusedVersions(); err != nil {
		t.Fatal(err)
	}
	if got := readJSON(t, settings)["extraKnownMarketplaces"]; !reflect.DeepEqual(got, map[string]any{}) {
		t.Fatalf("declared marketplaces = %v, want empty", got)
	}
}
