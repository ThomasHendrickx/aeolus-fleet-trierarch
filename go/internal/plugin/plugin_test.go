package plugin

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"

// thePlugin is this repository's aeolus-fleet plugin, its data and crews folders of the test's own.
func thePlugin(t *testing.T) Plugin {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	return Plugin{Root: filepath.Join(filepath.Dir(file), "..", "..", "..", "plugins", "aeolus-fleet"), Data: t.TempDir(), Crews: t.TempDir()}
}

func anIdentity(t *testing.T, plugin Plugin) string {
	t.Helper()
	folder := t.TempDir()
	if err := plugin.WriteIdentity(folder, Identity{FleetURL: "https://fleet.example", ShipID: scout, ShipName: "scout", Socket: "/run/scout/fleet.sock"}, "aeolus_ct_v1_scout"); err != nil {
		t.Fatalf("write: %v", err)
	}
	return folder
}

func TestAWrittenIdentityIsShown(t *testing.T) {
	plugin := thePlugin(t)
	folder := anIdentity(t, plugin)

	if !plugin.HasIdentity(folder) {
		t.Fatalf("no identity shown for %s", folder)
	}
}

func TestADeletedIdentityIsShownNoMore(t *testing.T) {
	plugin := thePlugin(t)
	folder := anIdentity(t, plugin)

	if err := plugin.DeleteIdentity(folder); err != nil {
		t.Fatal(err)
	}

	if plugin.HasIdentity(folder) {
		t.Fatalf("the identity stayed")
	}
}

func TestAFolderWithNoIdentityShowsNone(t *testing.T) {
	if thePlugin(t).HasIdentity(t.TempDir()) {
		t.Fatalf("an identity for a folder never crewed")
	}
}

func TestALaunchIsSeenOnlyOnceItsMarkerSaysIt(t *testing.T) {
	plugin := thePlugin(t)
	folder := anIdentity(t, plugin)
	if err := plugin.ClearLaunch(folder); err != nil {
		t.Fatal(err)
	}

	if seen := plugin.LaunchSeen(folder, "launch-1"); seen.IsActive || seen.IsStarted {
		t.Fatalf("seen before anything marked it: %+v", seen)
	}
}

func TestALaunchMarkerSaysWhatItsLaunchDid(t *testing.T) {
	seen := launchOf("launch launch-1\nstarted 2026-11-04T10:00:00Z /home/me/.claude/projects/x/abc.jsonl\nactive 2026-11-04T10:00:05Z\n", "launch-1")

	if !seen.IsStarted || !seen.IsActive {
		t.Fatalf("seen %+v", seen)
	}
}

func TestALaunchMarkerOfAnotherLaunchSaysNothingOfThisOne(t *testing.T) {
	seen := launchOf("launch launch-0\nstarted 2026-11-04T10:00:00Z x\nactive 2026-11-04T10:00:05Z\n", "launch-1")

	if seen.IsStarted || seen.IsActive {
		t.Fatalf("seen %+v", seen)
	}
}

func TestThePluginIsFoundWhereItsVariablesNameIt(t *testing.T) {
	plugin, err := Find("/home/me", map[string]string{"AEOLUS_PLUGIN_ROOT": "/plugin", "AEOLUS_PLUGIN_DATA": "/plugin-data"})

	if err != nil || plugin.Root != "/plugin" || plugin.Data != "/plugin-data" || plugin.Crews != "/home/me/.aeolus/crews/claude-code" {
		t.Fatalf("plugin %+v, %v", plugin, err)
	}
}

func TestThePluginIsTheNewestVersionInClaudeCodesCache(t *testing.T) {
	home := t.TempDir()
	cache := filepath.Join(home, ".claude", "plugins", "cache", "aeolus-fleet", "aeolus-fleet")
	for _, version := range []string{"0.9.0", "0.36.1", "0.4.12"} {
		if err := os.MkdirAll(filepath.Join(cache, version), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	plugin, err := Find(home, map[string]string{})

	if err != nil || plugin.Root != filepath.Join(cache, "0.36.1") || plugin.Data != filepath.Join(home, ".claude", "plugins", "data", "aeolus-fleet-aeolus-fleet") {
		t.Fatalf("plugin %+v, %v", plugin, err)
	}
}

func TestNoPluginInstalledIsSaid(t *testing.T) {
	if _, err := Find(t.TempDir(), map[string]string{}); err == nil {
		t.Fatalf("found a plugin where none is")
	}
}
