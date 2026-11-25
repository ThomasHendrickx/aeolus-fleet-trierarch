package cli

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/container"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

// containerGuardCheck checks the call of the guarded ship as its session in a container makes it, over its ship's socket.
func containerGuardCheck(at paths.Paths, call string) (string, int) {
	check := ContainerGuardCheck(at, container.Runtime{Homes: at.Homes, Sockets: at.Sockets, ShipsRoot: at.Ships})
	answer := check(context.Background(), guardedShip, io.NopCloser(strings.NewReader(call)))
	return strings.TrimSpace(answer.Stderr), answer.ExitCode
}

func TestAContainerSessionsGuardProtectsTheHarnessSettingsInTheContainersHome(t *testing.T) {
	_, at, folder := aGuardedShip(t, noPublishRules)
	for _, call := range []string{
		aHookCall(t, folder, "Write", map[string]any{"file_path": "/home/ubuntu/.claude/settings.json", "content": "{}"}),
		aHookCall(t, folder, "Bash", map[string]any{"command": "echo {} > ~/.claude/settings.json"}),
	} {
		refusal, code := containerGuardCheck(at, call)

		if want := "Refused by the guard: protected: /home/ubuntu/.claude/settings.json."; code != 2 || refusal != want {
			t.Errorf("guard check of %s = %q, %d, want %q", call, refusal, code, want)
		}
	}
}

func TestAContainerSessionsGuardFollowsALinkToWhereTheContainerSeesItsTarget(t *testing.T) {
	_, at, folder := aGuardedShip(t, noPublishRules)
	if err := os.Symlink("/home/ubuntu/.claude", filepath.Join(folder, "main", "config")); err != nil {
		t.Fatal(err)
	}

	refusal, code := containerGuardCheck(at, aHookCall(t, folder, "Write", map[string]any{"file_path": filepath.Join(folder, "main", "config", "settings.json"), "content": "{}"}))

	if want := "Refused by the guard: protected: /home/ubuntu/.claude/settings.json."; code != 2 || refusal != want {
		t.Fatalf("guard check = %q, %d, want %q", refusal, code, want)
	}
}

func TestAContainerSessionsGuardKeepsItsWritesInItsWorkspace(t *testing.T) {
	_, at, folder := aGuardedShip(t, noPublishRules)

	refusal, code := containerGuardCheck(at, aHookCall(t, folder, "Write", map[string]any{"file_path": "/home/ubuntu/notes.md", "content": "x"}))
	if want := "Refused by the guard: outside the boundary: /home/ubuntu/notes.md."; code != 2 || refusal != want {
		t.Fatalf("guard check of a write to its home = %q, %d, want %q", refusal, code, want)
	}
	_, code = containerGuardCheck(at, aHookCall(t, folder, "Write", map[string]any{"file_path": filepath.Join(folder, "main", "notes.md"), "content": "x"}))
	if code != 0 {
		t.Fatalf("a write in the main repository exited %d, want 0", code)
	}
}

func TestAContainerSessionsGuardRefusesByItsKeptRulesAndKeepsTheRefusal(t *testing.T) {
	_, at, folder := aGuardedShip(t, noPublishRules)

	refusal, code := containerGuardCheck(at, aHookCall(t, folder, "Bash", map[string]any{"command": "npm publish"}))

	if want := "Refused by the guard: commands.deny npm publish, in no-publish @ 8d41e07."; code != 2 || refusal != want {
		t.Fatalf("guard check = %q, %d, want %q", refusal, code, want)
	}
	if refusals := refusalsOf(t, at, guardedShip); len(refusals) != 1 || refusals[0]["rule"] != "commands.deny npm publish" || refusals[0]["set"] != "no-publish" {
		t.Fatalf("refusals = %v, want the one refusal with its rule and set", refusals)
	}
}

func TestAContainerSessionsGuardRefusesEveryCallWhileNoRulesAreKept(t *testing.T) {
	_, at, folder := aGuardedShip(t, "")

	refusal, code := containerGuardCheck(at, aHookCall(t, folder, "Bash", map[string]any{"command": "ls"}))

	if code != 2 || !strings.HasPrefix(refusal, "Refused by the guard: guard failed: ") {
		t.Fatalf("guard check = %q, %d, want guard failed", refusal, code)
	}
}

func TestAContainerSessionsGuardRefusesEveryCallOfAShipNotCrewedHere(t *testing.T) {
	_, at, folder := aGuardedShip(t, noPublishRules)
	check := ContainerGuardCheck(at, container.Runtime{Homes: at.Homes, Sockets: at.Sockets, ShipsRoot: at.Ships})

	answer := check(context.Background(), "shp_01m6jyczpnpp5c0vxh54c966cz", io.NopCloser(strings.NewReader(aHookCall(t, folder, "Bash", map[string]any{"command": "ls"}))))

	if want := "Refused by the guard: guard failed: ship not crewed here."; answer.ExitCode != 2 || strings.TrimSpace(answer.Stderr) != want {
		t.Fatalf("guard check = %q, %d, want %q", answer.Stderr, answer.ExitCode, want)
	}
}

func TestAContainerSessionsGuardCheckStopsReadingWhenItsDeadlineEnds(t *testing.T) {
	_, at, folder := aGuardedShip(t, noPublishRules)
	// The state is a pipe no one writes: its read waits as a stalled file system's would, until the pipe is closed at the test's end.
	if err := os.Remove(at.State); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(at.State, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if writer, err := os.OpenFile(at.State, os.O_WRONLY|syscall.O_NONBLOCK, 0); err == nil {
			_ = writer.Close()
		}
	})
	check := ContainerGuardCheck(at, container.Runtime{Homes: at.Homes, Sockets: at.Sockets, ShipsRoot: at.Ships})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	answered := make(chan guard.Answer, 1)

	go func() {
		answered <- check(ctx, guardedShip, io.NopCloser(strings.NewReader(aHookCall(t, folder, "Bash", map[string]any{"command": "ls"}))))
	}()

	select {
	case answer := <-answered:
		if answer.ExitCode != 2 {
			t.Fatalf("guard check = %q, %d, want a refusal", answer.Stderr, answer.ExitCode)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the guard check still read 3 seconds after its deadline ended")
	}
}
