package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/claudecode"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/container"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/modelproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/test/fakemodel"
)

// The guard of a Claude Code session in a container (#631), as this computer runs it: the trierarch's own container runtime, holds,
// harness and ship sockets, the session image's Claude Code in a real rootless container, its PreToolUse hook asking the ship's socket
// on the host, under a deterministic model server reached as the model proxy, so it needs no account or key. Only with
// AEOLUS_TEST_CLAUDE_CODE=1 and AEOLUS_TEST_SESSION_IMAGE naming a session image the runtime holds. A call ran when its marker appears
// in the ship's folder, which the container mounts.

const realContainerShip = "shp_01m8a2a0kfj4m3c7sx1q9wd5vb"

// realNoRm are kept rules with one set that denies rm alone, so a touch is checked and let run.
const realNoRm = `[{"name":"no-rm","repository":"fleet/rules","commit":"8d41e07aa1","file":"no-rm.yaml","floor":false,"rules":{"commands":{"deny":[{"command":"rm"}]}}}]`

// realNoTouch are kept rules with one set that denies touch.
const realNoTouch = `[{"name":"no-touch","repository":"fleet/rules","commit":"8d41e07aa1","file":"no-touch.yaml","floor":false,"rules":{"commands":{"deny":[{"command":"touch"}]}}}]`

func TestARealClaudeCodeSessionInAContainerRunsACallItsShipsSocketLets(t *testing.T) {
	session := aRealContainerSession(t, realNoRm)

	result := session.run(t)

	if !result.ran {
		t.Fatalf("the call did not run: %s", result.events)
	}
	if !strings.Contains(result.log, "guard check "+realContainerShip+" allowed") {
		t.Fatalf("the trierarch logged %q, want the call checked on the host through the ship's socket", result.log)
	}
}

func TestARealClaudeCodeSessionInAContainerDoesNotRunACallTheRulesDenyAndShowsItsRule(t *testing.T) {
	session := aRealContainerSession(t, realNoTouch)

	result := session.run(t)

	if result.ran || !strings.Contains(result.events, "Refused by the guard: commands.deny touch, in no-touch @ 8d41e07.") {
		t.Fatalf("ran %v, want the call refused with its rule: %s", result.ran, result.events)
	}
	refusals, err := os.ReadFile(filepath.Join(guardfile.Folder(session.at.Guard, realContainerShip), "refusals.jsonl"))
	if err != nil || !strings.Contains(string(refusals), `"rule":"commands.deny touch"`) {
		t.Fatalf("refusals %s, %v, want the refusal kept on the host", refusals, err)
	}
	if !strings.Contains(result.log, "guard check "+realContainerShip+" refused") {
		t.Fatalf("the trierarch logged %q, want the call refused on the host through the ship's socket", result.log)
	}
}

func TestARealClaudeCodeSessionInAContainerOfARequestWithoutARuleSetRunsItsCallUnchecked(t *testing.T) {
	session := aRealContainerSession(t, "[]")

	result := session.run(t)

	if !result.ran || strings.Contains(result.log, "guard check") {
		t.Fatalf("ran %v, the trierarch logged %q, want the call run without the guard, as before", result.ran, result.log)
	}
}

func TestARealClaudeCodeSessionInAContainerDoesNotRunACallWhenItsShipsSocketIsGone(t *testing.T) {
	session := aRealContainerSession(t, realNoRm)
	session.isSocketClosed = true

	result := session.run(t)

	if result.ran {
		t.Fatalf("the call ran with no socket to check it: %s", result.events)
	}
}

func TestARealClaudeCodeSessionInAContainerDoesNotRunACallWhenTheGuardMissesItsDeadline(t *testing.T) {
	session := aRealContainerSession(t, realNoTouch)
	// A refusal kept through a pipe no one reads hangs until the socket's deadline answers.
	if err := syscall.Mkfifo(filepath.Join(guardfile.Folder(session.at.Guard, realContainerShip), "refusals.jsonl"), 0o600); err != nil {
		t.Fatal(err)
	}

	result := session.run(t)

	if result.ran || !strings.Contains(result.events, "Refused by the guard: guard failed: deadline.") {
		t.Fatalf("ran %v, want the call refused at the guard's deadline: %s", result.ran, result.events)
	}
}

// realContainerSession is a ship crewed in its ship's folder with its rules kept, on a trierarch whose sessions run in containers.
type realContainerSession struct {
	home           string
	at             paths.Paths
	entry          reconciler.Entry
	image          string
	isSocketClosed bool
}

func aRealContainerSession(t *testing.T, sets string) *realContainerSession {
	t.Helper()
	image := os.Getenv("AEOLUS_TEST_SESSION_IMAGE")
	if os.Getenv("AEOLUS_TEST_CLAUDE_CODE") != "1" || image == "" {
		t.Skip("runs Claude Code in a real container: only with AEOLUS_TEST_CLAUDE_CODE=1 and AEOLUS_TEST_SESSION_IMAGE")
	}
	// A short home: a socket's path has a limit t.TempDir's names exceed.
	made, err := os.MkdirTemp("", "g")
	if err != nil {
		t.Fatal(err)
	}
	home, err := filepath.EvalSymlinks(made)
	if err != nil {
		t.Fatal(err)
	}
	at := paths.Of(home, "")
	t.Cleanup(func() { _ = container.Runtime{Binary: "podman"}.RemoveWithinUserNamespace(home) })
	shipFolder := filepath.Join(at.Ships, realContainerShip)
	folder := filepath.Join(shipFolder, "repositories")
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	entry := reconciler.Entry{ShipID: realContainerShip, ShipName: "scout", SettingsVersion: 1, Harness: "claude-code", State: "running", Folder: folder, ShipFolder: shipFolder, Login: "apiKey", Options: map[string]string{}, FirstPrompt: "Run the requested Bash action once."}
	crewed := reconciler.Empty()
	crewed.Entries[realContainerShip] = entry
	if err := (state.File{Path: at.State}).Save(crewed); err != nil {
		t.Fatal(err)
	}
	rules := `{"fleetId":"flt_01m3tb1zgr5h2ffee12xnch8sv","pluginShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","shipId":"` + realContainerShip + `","settingsVersion":1,"sets":` + sets + `}`
	if err := (guardfile.Store{Guards: at.Guard}).Write(context.Background(), realContainerShip, []byte(rules)); err != nil {
		t.Fatal(err)
	}
	return &realContainerSession{home: home, at: at, entry: entry, image: image}
}

type realContainerResult struct {
	ran    bool
	events string
	// log is what the trierarch's ship sockets logged.
	log string
}

// run starts the ship's session as the trierarch starts it in a container, its model asking for one `touch` in its folder, and waits
// for its turn to end.
func (s *realContainerSession) run(t *testing.T) realContainerResult {
	t.Helper()
	marker := filepath.Join(s.entry.Folder, "ran")
	model := fakemodel.BashModel(t, "touch "+marker)
	if err := os.MkdirAll(s.at.Proxy, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(modelproxy.FilesOf(s.at.Proxy).Port, []byte(model.URL[strings.LastIndex(model.URL, ":")+1:]), 0o600); err != nil {
		t.Fatal(err)
	}
	// The operator's acceptance of bypass permissions mode on the host, which its ship's home takes.
	if err := os.MkdirAll(filepath.Join(s.home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.home, ".claude", "settings.json"), []byte(`{"skipDangerousModePermissionPrompt":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	configuration := config.Configuration{
		Runtime:   &config.Runtime{Kind: "container", Binary: "podman", Memory: "2g", Cpus: 2},
		Harnesses: map[string]config.Harness{"claude-code": {Flags: []string{"--dangerously-skip-permissions", "--model", fakemodel.Model}, Options: map[string]config.Option{}}},
	}
	program := builtProgram(t)
	running, ok := sessionRuntime(s.at, program, configuration).(container.Runtime)
	if !ok {
		t.Fatal("the session runtime in containers is no container runtime")
	}
	running.Image = s.image
	running.Holds.Launch = nil
	logged := &lockedLog{}
	kept := stderr
	stderr = logged
	t.Cleanup(func() { stderr = kept })
	opened := shipSockets(s.at, "http://127.0.0.1:9", running)
	t.Cleanup(opened.CloseAll)
	if _, err := opened.Open(realContainerShip, s.entry.ShipFolder); err != nil {
		t.Fatal(err)
	}
	if s.isSocketClosed {
		opened.Close(realContainerShip, s.entry.ShipFolder)
	}
	// The aeolus-fleet plugin of this tree, as the host finds it; the container runs its image's.
	pluginRoot, err := filepath.Abs(filepath.Join("..", "..", "..", "plugins", "aeolus-fleet"))
	if err != nil {
		t.Fatal(err)
	}
	wired, _, err := harnessesOf(configuration, s.at, map[string]string{"AEOLUS_PLUGIN_ROOT": pluginRoot}, s.home, program, running, modelproxy.Runtime{Folder: s.at.Proxy}, &offers{configured: configuration})
	if err != nil {
		t.Fatal(err)
	}
	harness, ok := wired["claude-code"].(claudecode.Harness)
	if !ok {
		t.Fatalf("claude-code is wired as %T, want claudecode.Harness", wired["claude-code"])
	}
	t.Cleanup(func() { _ = running.Stop(realContainerShip) })

	if err := harness.Launch(s.entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	events := ""
	for until := time.Now().Add(150 * time.Second); time.Now().Before(until); time.Sleep(500 * time.Millisecond) {
		text, _ := os.ReadFile(hold.FilesOf(s.at.Sessions, realContainerShip).Events)
		events = string(text)
		if strings.Contains(events, `"type":"result"`) {
			break
		}
	}
	if !strings.Contains(events, `"type":"result"`) {
		t.Fatalf("the session's turn did not end: %s", events)
	}
	_, statErr := os.Stat(marker)
	return realContainerResult{ran: statErr == nil, events: events, log: logged.text()}
}

// builtProgram is the trierarch built from this tree: its holds run it as `hold`, its harness's guard names it.
func builtProgram(t *testing.T) string {
	t.Helper()
	program := filepath.Join(t.TempDir(), "aeolus-trierarch")
	build := exec.Command("go", "build", "-o", program, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, output)
	}
	return program
}

// lockedLog is the trierarch's log as its ship sockets write it, from their own goroutines.
type lockedLog struct {
	mutex sync.Mutex
	lines strings.Builder
}

func (l *lockedLog) Write(text []byte) (int, error) {
	l.mutex.Lock()
	defer l.mutex.Unlock()
	return l.lines.Write(text)
}

func (l *lockedLog) text() string {
	l.mutex.Lock()
	defer l.mutex.Unlock()
	return l.lines.String()
}
