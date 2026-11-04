package codex

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

// upgradedAt is when each test's upgrade runs.
var upgradedAt = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

// aCodexHome is a `codex` whose plugin commands keep its plugin cache as Codex does, in the Codex home given or the throwaway one CODEX_HOME names: the marketplace upgrade replaces every version folder with 0.41.0 when there is one to update, plugin add installs 0.41.0, and each command line is kept. A file in its folder changes it: `fails` fails the upgrade once it deleted the version folders, `deletes-data` makes marketplace remove delete the plugin data folders.
type aCodexHome struct {
	folder string
	home   string
}

func aCodexOn(t *testing.T) aCodexHome {
	t.Helper()
	t.Setenv("CODEX_HOME", "")
	folder := t.TempDir()
	home := filepath.Join(t.TempDir(), ".codex")
	script := `#!/bin/sh
folder='` + folder + `'
codexHome="${CODEX_HOME:-` + home + `}"
if [ -n "$CODEX_HOME" ]; then echo "$*" >> "$folder/proof-calls.txt"; else echo "$*" >> "$folder/calls.txt"; fi
cache="$codexHome/plugins/cache/aeolus-fleet/aeolus-fleet"
install() { mkdir -p "$cache/0.41.0/.codex-plugin" && echo '{"version":"0.41.0"}' > "$cache/0.41.0/.codex-plugin/plugin.json"; }
case "$2 $3" in
  'marketplace remove') [ -e "$folder/deletes-data" ] && rm -rf "$codexHome/plugins/data" ;;
  'marketplace upgrade')
    if [ -n "$(ls "$cache" 2>/dev/null)" ]; then
      rm -rf "${cache:?}"/*
      if [ -e "$folder/fails" ]; then echo 'Failed to reach github.com' >&2; exit 1; fi
      install
    fi ;;
  'add aeolus-fleet@aeolus-fleet') install ;;
esac
exit 0
`
	if err := os.WriteFile(filepath.Join(folder, "codex"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return aCodexHome{folder: folder, home: home}
}

func (c aCodexHome) cache() string {
	return filepath.Join(c.home, "plugins", "cache", "aeolus-fleet", "aeolus-fleet")
}

func (c aCodexHome) toggle(t *testing.T, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(c.folder, name), nil, 0o644); err != nil {
		t.Fatal(err)
	}
}

// versionFolder is a version folder of the plugin in the cache, its version come at the time given.
func (c aCodexHome) versionFolder(t *testing.T, version string, came time.Time) {
	t.Helper()
	folder := filepath.Join(c.cache(), version)
	if err := os.MkdirAll(filepath.Join(folder, ".codex-plugin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, ".codex-plugin", "plugin.json"), []byte(`{"version":"`+version+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(folder, came, came); err != nil {
		t.Fatal(err)
	}
}

func (c aCodexHome) versions(t *testing.T) []string {
	t.Helper()
	entries, _ := os.ReadDir(c.cache())
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// calls are the command lines run against the Codex home, not the throwaway one of the proof.
func (c aCodexHome) calls(t *testing.T) []string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(c.folder, "calls.txt"))
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(text)), "\n")
}

// update runs the plugin update with the processes given running, and the trierarch's pid.
func (c aCodexHome) update(t *testing.T, processes []Process, trierarch int) error {
	t.Helper()
	return PluginUpdate{
		Program:      filepath.Join(c.folder, "codex"),
		Home:         c.home,
		Now:          func() time.Time { return upgradedAt },
		Processes:    func(time.Time) ([]Process, error) { return processes, nil },
		TrierarchPID: func() int { return trierarch },
	}.Update("v0.41.0")
}

func TestPluginUpdatePointsTheMarketplaceAtTheReleaseTagAndUpgradesIt(t *testing.T) {
	codex := aCodexOn(t)
	codex.versionFolder(t, "0.40.0", upgradedAt.Add(-time.Hour))

	if err := codex.update(t, nil, 0); err != nil {
		t.Fatal(err)
	}

	want := []string{
		"plugin marketplace remove aeolus-fleet",
		"plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch --ref v0.41.0",
		"plugin marketplace upgrade aeolus-fleet",
		"plugin remove aeolus@aeolus-fleet",
	}
	if got := codex.calls(t); !reflect.DeepEqual(got, want) {
		t.Errorf("ran %q, want %q", got, want)
	}
}

func TestPluginUpdateAddsThePluginWhenCodexHoldsNoVersionOfIt(t *testing.T) {
	codex := aCodexOn(t)

	if err := codex.update(t, nil, 0); err != nil {
		t.Fatal(err)
	}

	if !slices.Contains(codex.calls(t), "plugin add aeolus-fleet@aeolus-fleet") || !reflect.DeepEqual(codex.versions(t), []string{"0.41.0"}) {
		t.Errorf("ran %q with versions %q, want the plugin added at 0.41.0", codex.calls(t), codex.versions(t))
	}
}

func TestPluginUpdateChangesNothingWhenThisCodexDeletesThePluginsDataWithItsMarketplace(t *testing.T) {
	codex := aCodexOn(t)
	codex.toggle(t, "deletes-data")
	data := filepath.Join(codex.home, "plugins", "data", "aeolus-fleet-aeolus-fleet")
	if err := os.MkdirAll(data, 0o755); err != nil {
		t.Fatal(err)
	}

	err := codex.update(t, nil, 0)

	if !errors.Is(err, ErrDeletesPluginData) {
		t.Fatalf("Update() = %v, want ErrDeletesPluginData", err)
	}
	if calls := codex.calls(t); len(calls) != 0 {
		t.Errorf("ran %q against the Codex home, want nothing", calls)
	}
	if _, err := os.Stat(data); err != nil {
		t.Errorf("the plugin's data: %v, want it kept", err)
	}
}

func TestPluginUpdatePutsBackEachVersionFolderCodexDeletedWithItsTimeWhenTheUpgradeFails(t *testing.T) {
	codex := aCodexOn(t)
	came := upgradedAt.Add(-48 * time.Hour).Truncate(time.Second)
	codex.versionFolder(t, "0.40.0", came)
	codex.toggle(t, "fails")

	err := codex.update(t, nil, 0)

	if err == nil || !strings.Contains(err.Error(), "Failed to reach github.com") {
		t.Fatalf("Update() = %v, want the upgrade's failure", err)
	}
	if _, err := os.Stat(filepath.Join(codex.cache(), "0.40.0", ".codex-plugin", "plugin.json")); err != nil {
		t.Fatalf("0.40.0: %v, want it put back", err)
	}
	folder, err := os.Stat(filepath.Join(codex.cache(), "0.40.0"))
	if err != nil {
		t.Fatal(err)
	}
	if !folder.ModTime().Equal(came) {
		t.Errorf("0.40.0 came %v, want %v", folder.ModTime(), came)
	}
}

func TestPluginUpdateMarksTheVersionItInstalledWithTheTimeOfTheUpgrade(t *testing.T) {
	codex := aCodexOn(t)
	codex.versionFolder(t, "0.40.0", upgradedAt.Add(-time.Hour))
	running := []Process{{PID: 7, Program: "codex", StartedAt: upgradedAt.Add(-2 * time.Hour)}}

	if err := codex.update(t, running, 0); err != nil {
		t.Fatal(err)
	}

	folder, err := os.Stat(filepath.Join(codex.cache(), "0.41.0"))
	if err != nil {
		t.Fatal(err)
	}
	if !folder.ModTime().Equal(upgradedAt) {
		t.Errorf("0.41.0 came %v, want %v", folder.ModTime(), upgradedAt)
	}
}

func TestPluginUpdateRemovesTheVersionFoldersNoRunningCodexOrTrierarchCanUse(t *testing.T) {
	// 0.39.0 left 0.38.0 behind before every start; 0.40.0 came after the earliest one, so 0.39.0 may still run; 0.41.0 is the one installed.
	earliest := upgradedAt.Add(-2 * time.Hour)
	cases := []struct {
		name      string
		processes []Process
		trierarch int
		want      []string
	}{
		{"with a Codex process running", []Process{{PID: 7, Program: "/usr/local/bin/codex", StartedAt: earliest}, {PID: 8, Program: "bash", StartedAt: earliest.Add(-48 * time.Hour)}}, 0, []string{"0.39.0", "0.40.0", "0.41.0"}},
		{"with the trierarch running", []Process{{PID: 9, Program: "aeolus-trierarch", StartedAt: earliest}}, 9, []string{"0.39.0", "0.40.0", "0.41.0"}},
		{"with nothing running", nil, 0, []string{"0.41.0"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			codex := aCodexOn(t)
			codex.versionFolder(t, "0.38.0", earliest.Add(-3*time.Hour))
			codex.versionFolder(t, "0.39.0", earliest.Add(-2*time.Hour))
			codex.versionFolder(t, "0.40.0", earliest.Add(time.Minute))

			if err := codex.update(t, c.processes, c.trierarch); err != nil {
				t.Fatal(err)
			}

			if got := codex.versions(t); !reflect.DeepEqual(got, c.want) {
				t.Errorf("versions %q, want %q", got, c.want)
			}
		})
	}
}

func TestAVersionWhoseNextCameWithinAMinuteBeforeTheEarliestStartIsKept(t *testing.T) {
	// ps says elapsed time in whole seconds, and a session takes a moment to read its plugin.
	earliest := upgradedAt.Add(-2 * time.Hour)
	cases := []struct {
		name string
		next time.Time
		want []string
	}{
		{"a minute before", earliest.Add(-time.Minute), []string{"0.40.0", "0.41.0"}},
		{"just within a minute", earliest.Add(-time.Minute + time.Second), []string{"0.39.0", "0.40.0", "0.41.0"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			codex := aCodexOn(t)
			codex.versionFolder(t, "0.39.0", earliest.Add(-time.Hour))
			codex.versionFolder(t, "0.40.0", c.next)

			if err := codex.update(t, []Process{{PID: 7, Program: "codex", StartedAt: earliest}}, 0); err != nil {
				t.Fatal(err)
			}

			if got := codex.versions(t); !reflect.DeepEqual(got, c.want) {
				t.Errorf("versions %q, want %q", got, c.want)
			}
		})
	}
}

func TestProcessesAreWhatPsSaysEachStartedItsElapsedTimeBeforeNow(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	said := "    1 3-04:05:06 systemd\n  420    01:02:03 codex\n 4200       00:09 /usr/local/bin/codex app\nnot a process\n"

	got := processesOf(said, now)

	want := []Process{
		{PID: 1, Program: "systemd", StartedAt: now.Add(-(3*24*time.Hour + 4*time.Hour + 5*time.Minute + 6*time.Second))},
		{PID: 420, Program: "codex", StartedAt: now.Add(-(time.Hour + 2*time.Minute + 3*time.Second))},
		{PID: 4200, Program: "/usr/local/bin/codex app", StartedAt: now.Add(-9 * time.Second)},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("processesOf(%q) = %v, want %v", said, got, want)
	}
}
