package plugin

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCodexsPluginIsFoundWhereItsVariablesNameIt(t *testing.T) {
	plugin, err := FindCodex("/home/me", map[string]string{"AEOLUS_CODEX_PLUGIN_ROOT": "/plugin", "AEOLUS_CODEX_PLUGIN_DATA": "/plugin-data"})

	if want := (Plugin{Root: "/plugin", Data: "/plugin-data", Crews: "/home/me/.aeolus/crews/codex"}); err != nil || plugin != want {
		t.Fatalf("FindCodex = %+v, %v, want %+v", plugin, err, want)
	}
}

func TestCodexsPluginIsTheNewestVersionInItsCacheInCodexHome(t *testing.T) {
	codexHome := t.TempDir()
	cache := filepath.Join(codexHome, "plugins", "cache", "aeolus-fleet", "aeolus-fleet")
	for _, version := range []string{"0.9.0", "0.36.1"} {
		if err := os.MkdirAll(filepath.Join(cache, version), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	plugin, err := FindCodex("/home/me", map[string]string{"CODEX_HOME": codexHome})

	if want := (Plugin{Root: filepath.Join(cache, "0.36.1"), Data: filepath.Join(codexHome, "plugins", "data", "aeolus-fleet-aeolus-fleet"), Crews: "/home/me/.aeolus/crews/codex"}); err != nil || plugin != want {
		t.Fatalf("FindCodex = %+v, %v, want %+v", plugin, err, want)
	}
}

func TestNoCodexPluginInstalledIsSaid(t *testing.T) {
	if _, err := FindCodex(t.TempDir(), map[string]string{}); err == nil {
		t.Fatalf("found a Codex plugin where none is")
	}
}

func TestCopilotsPluginIsWhereCopilotInstallsItInItsHome(t *testing.T) {
	plugin := FindCopilot("/home/me", map[string]string{})

	if want := (Plugin{Root: "/home/me/.copilot/installed-plugins/aeolus-fleet/aeolus-fleet", Data: "/home/me/.copilot/plugin-data/aeolus-fleet/aeolus-fleet", Crews: "/home/me/.aeolus/crews/copilot"}); plugin != want {
		t.Fatalf("FindCopilot = %+v, want %+v", plugin, want)
	}
}

func TestCopilotsPluginFollowsCopilotHomeAndItsVariables(t *testing.T) {
	plugin := FindCopilot("/home/me", map[string]string{"COPILOT_HOME": "/copilot", "AEOLUS_COPILOT_PLUGIN_ROOT": "/plugin"})

	if want := (Plugin{Root: "/plugin", Data: "/copilot/plugin-data/aeolus-fleet/aeolus-fleet", Crews: "/home/me/.aeolus/crews/copilot"}); plugin != want {
		t.Fatalf("FindCopilot = %+v, want %+v", plugin, want)
	}
}

func TestACopilotPluginNotInstalledIsSaidAtUseNotAtStart(t *testing.T) {
	plugin := FindCopilot(t.TempDir(), map[string]string{})

	if err := plugin.IsInstalled(); err == nil {
		t.Fatalf("IsInstalled = nil for %s, want the plugin said missing", plugin.Root)
	}
}
