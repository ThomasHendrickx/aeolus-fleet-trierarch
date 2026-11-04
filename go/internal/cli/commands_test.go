package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"

func trierarchHome(machine Machine) paths.Paths {
	return paths.Of(machine.HomeDirectory, "")
}

func TestRunRefusesACoreOlderThanItNeedsBeforeItSaysItsVersion(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	_ = os.Remove(trierarchHome(machine).Running)
	machine.CoreVersionRefusal = func(string) string { return "trierarch 1.0.0 needs core 0.35.0 or later" }

	output, code := Main([]string{"run"}, machine)

	if code != 1 || output != "trierarch 1.0.0 needs core 0.35.0 or later" {
		t.Fatalf("answered %q, %d", output, code)
	}
	if _, err := os.Stat(trierarchHome(machine).Running); err == nil {
		t.Fatalf("running.json was written")
	}
}

func TestRunRunsAPassEveryIntervalUntilItIsStopped(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	stop := make(chan struct{})
	machine.Stop = stop
	passes := 0
	machine.NewPass = func(paths.Paths, crew.File, config.Configuration) (func() error, error) {
		return func() error {
			passes++
			if passes == 3 {
				close(stop)
			}
			return nil
		}, nil
	}

	_, code := Main([]string{"run"}, machine)

	if code != 0 || passes != 3 {
		t.Fatalf("code %d after %d passes", code, passes)
	}
}

func TestAFailedPassIsLoggedAndTheLoopGoesOn(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	stop := make(chan struct{})
	machine.Stop = stop
	logged := []string{}
	machine.Log = func(line string) { logged = append(logged, line) }
	passes := 0
	machine.NewPass = func(paths.Paths, crew.File, config.Configuration) (func() error, error) {
		return func() error {
			passes++
			if passes == 2 {
				close(stop)
			}
			return os.ErrDeadlineExceeded
		}, nil
	}

	Main([]string{"run"}, machine)

	if passes != 2 || !slices.ContainsFunc(logged, func(line string) bool { return strings.Contains(line, "the pass failed") }) {
		t.Fatalf("%d passes, logged %q", passes, logged)
	}
}

func TestListSaysEachShipItCrewsFromItsState(t *testing.T) {
	machine, _, _ := aMain(t)
	saved := reconciler.Empty()
	saved.Entries[scout] = reconciler.Entry{ShipID: scout, State: "running", Harness: "claude-code", Workspace: reconciler.Workspace{Kind: "worktree", Repository: "aeolus-fleet"}, Folder: "/w/aeolus-fleet/scout", Since: "2026-11-04T10:00:00Z", Exits: []string{"2026-11-04T09:59:00Z"}, Options: map[string]string{}}
	if err := (state.File{Path: trierarchHome(machine).State}).Save(saved); err != nil {
		t.Fatal(err)
	}

	output, code := Main([]string{"list", "--json"}, machine)

	if code != 0 || strings.ReplaceAll(strings.ReplaceAll(output, " ", ""), "\n", "") != `[{"shipId":"`+scout+`","state":"running","harness":"claude-code","workspace":"worktreeaeolus-fleet","folder":"/w/aeolus-fleet/scout","since":"2026-11-04T10:00:00Z","restarts":1}]` {
		t.Fatalf("answered %s, %d", output, code)
	}
}

func TestListSaysNoShipIsCrewedBeforeAny(t *testing.T) {
	machine, _, _ := aMain(t)

	output, code := Main([]string{"list"}, machine)

	if code != 0 || output != "No ship is crewed here." {
		t.Fatalf("answered %q, %d", output, code)
	}
}

func aCheckout(t *testing.T) string {
	t.Helper()
	repository := filepath.Join(t.TempDir(), "aeolus-fleet")
	if out, err := exec.Command("git", "init", "-q", repository).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	return repository
}

func TestAddRepositoryWritesItTrustsItAndRestartsTheService(t *testing.T) {
	machine, installed, _ := aMain(t)
	claudeCode := &aClaudeCode{}
	machine.ClaudeCode = func(string, string) ClaudeCode { return claudeCode }
	Main(setupWords(), machine)
	repository := aCheckout(t)
	installed.calls = nil

	output, code := Main([]string{"add", "repository", "aeolus-fleet", repository}, machine)

	if code != 0 || !strings.Contains(output, "Added the repository aeolus-fleet") {
		t.Fatalf("answered %q, %d", output, code)
	}
	configuration, err := config.Load(trierarchHome(machine).Config)
	if err != nil || configuration.Repositories["aeolus-fleet"].Path != repository {
		t.Fatalf("configuration %+v, %v", configuration.Repositories, err)
	}
	if !slices.Contains(claudeCode.trusted, repository) || !slices.Equal(installed.calls, []string{"restart"}) {
		t.Fatalf("trusted %q, service %q", claudeCode.trusted, installed.calls)
	}
}

func TestAddRepositoryRefusesAFolderThatIsNoGitCheckout(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	folder := t.TempDir()

	output, code := Main([]string{"add", "repository", "aeolus-fleet", folder}, machine)

	if code != 1 || output != folder+" is no git checkout" {
		t.Fatalf("answered %q, %d", output, code)
	}
}

func TestAddRefusesANameThatIsNoName(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)

	output, code := Main([]string{"add", "folder", "Notes", t.TempDir()}, machine)

	if code != 1 || !strings.Contains(output, "Notes is no name") {
		t.Fatalf("answered %q, %d", output, code)
	}
}

func TestRestartRestartsTheServiceAndSaysOnceItRunsAgain(t *testing.T) {
	machine, installed, _ := aMain(t)
	Main(setupWords(), machine)
	installed.calls = nil

	output, code := Main([]string{"restart"}, machine)

	if code != 0 || !slices.Equal(installed.calls, []string{"restart"}) || !strings.Contains(output, "restarted") {
		t.Fatalf("answered %q, %d, service %q", output, code, installed.calls)
	}
}

func TestStopAndStartDriveTheService(t *testing.T) {
	machine, installed, _ := aMain(t)
	Main(setupWords(), machine)
	installed.calls = nil

	Main([]string{"stop"}, machine)
	Main([]string{"start"}, machine)

	if !slices.Equal(installed.calls, []string{"stop", "start"}) {
		t.Fatalf("service %q", installed.calls)
	}
}

func TestUninstallStopsEverySessionItRan(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	running := &aSessionRuntime{running: []string{scout}}
	machine.Sessions = func(paths.Paths) Sessions { return running }

	_, code := Main([]string{"uninstall"}, machine)

	if code != 0 || !slices.Equal(running.stopped, []string{scout}) {
		t.Fatalf("code %d, stopped %q", code, running.stopped)
	}
}
