package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/claudecode"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/container"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/modelproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/runpass"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipsocket"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/workspace"
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
	if !strings.Contains(result.log, "guard check "+session.entry.ShipID+" allowed") {
		t.Fatalf("the trierarch logged %q, want the call checked on the host through the ship's socket", result.log)
	}
}

func TestARealClaudeCodeSessionInAContainerDoesNotRunACallTheRulesDenyAndShowsItsRule(t *testing.T) {
	session := aRealContainerSession(t, realNoTouch)

	result := session.run(t)

	if result.ran || !strings.Contains(result.events, "Refused by the guard: commands.deny touch, in no-touch @ 8d41e07.") {
		t.Fatalf("ran %v, want the call refused with its rule: %s", result.ran, result.events)
	}
	refusals, err := os.ReadFile(filepath.Join(guardfile.Folder(session.at.Guard, session.entry.ShipID), "refusals.jsonl"))
	if err != nil || !strings.Contains(string(refusals), `"rule":"commands.deny touch"`) {
		t.Fatalf("refusals %s, %v, want the refusal kept on the host", refusals, err)
	}
	if !strings.Contains(result.log, "guard check "+session.entry.ShipID+" refused") {
		t.Fatalf("the trierarch logged %q, want the call refused on the host through the ship's socket", result.log)
	}
}

func TestARealClaudeCodeSessionInAContainerChecksASymlinkInTheContainersView(t *testing.T) {
	for _, scenario := range []struct {
		name string
		sets string
		runs bool
	}{
		{name: "unguarded call reaches the mounted home", sets: "[]", runs: true},
		{name: "guarded call is refused at the resolved path", sets: realNoRm},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			session := aRealContainerSession(t, scenario.sets)
			link := filepath.Join(session.entry.Folder, "ship-home")
			if err := os.Symlink("/home/ubuntu", link); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(session.entry.ShipFolder, "home", "ran")
			result := session.runTouch(t, filepath.Join(link, "ran"), marker)

			if result.ran != scenario.runs {
				t.Fatalf("call ran = %v, want %v: %s", result.ran, scenario.runs, result.events)
			}
			if !scenario.runs && !strings.Contains(result.events, "Refused by the guard: outside the boundary: /home/ubuntu/ran.") {
				t.Fatalf("want a refusal naming the resolved path in the container: %s", result.events)
			}
		})
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
	refusals := filepath.Join(guardfile.Folder(session.at.Guard, session.entry.ShipID), "refusals.jsonl")
	if err := syscall.Mkfifo(refusals, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { releaseRefusalWriters(t, refusals) })

	result := session.run(t)

	if result.ran || !strings.Contains(result.events, "Refused by the guard: guard failed: deadline.") {
		t.Fatalf("ran %v, want the call refused at the guard's deadline: %s", result.ran, result.events)
	}
}

// refusalWriterWait is how long a refusal writer blocked on the refusals pipe has to end once the pipe has a reader.
const refusalWriterWait = 10 * time.Second

// releaseRefusalWriters gives the refusals pipe a reader, so every refusal writer blocked opening it goes on and ends, and fails the
// test when none was blocked on it, or one is still at it after refusalWriterWait.
func releaseRefusalWriters(t *testing.T, pipe string) {
	t.Helper()
	stacks := make([]byte, 1<<20)
	if written := runtime.Stack(stacks, true); !strings.Contains(string(stacks[:written]), "guardfile.Refusals.Append") {
		t.Errorf("no refusal writer is blocked on %s, want the deadline to come from the refusal kept through it", pipe)
	}
	reader, err := os.OpenFile(pipe, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		t.Errorf("open the refusals pipe for reading: %v", err)
		return
	}
	defer func() { _ = reader.Close() }()
	for until := time.Now().Add(refusalWriterWait); ; time.Sleep(50 * time.Millisecond) {
		written := runtime.Stack(stacks, true)
		if !strings.Contains(string(stacks[:written]), "guardfile.Refusals.Append") {
			return
		}
		if time.Now().After(until) {
			t.Errorf("a refusal writer is still blocked on %s %s after it got a reader:\n%s", pipe, refusalWriterWait, stacks[:written])
			return
		}
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
	var id [12]byte
	if _, err := rand.Read(id[:]); err != nil {
		t.Fatal(err)
	}
	shipID := "shp_01" + hex.EncodeToString(id[:])
	t.Cleanup(func() { _ = container.Runtime{Binary: "podman"}.RemoveWithinUserNamespace(home) })
	shipFolder := filepath.Join(at.Ships, shipID)
	folder := filepath.Join(shipFolder, "repositories")
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	entry := reconciler.Entry{ShipID: shipID, ShipName: "scout", SettingsVersion: 1, Harness: "claude-code", State: "running", Folder: folder, ShipFolder: shipFolder, Login: "apiKey", Options: map[string]string{}, FirstPrompt: "Run the requested Bash action once."}
	crewed := reconciler.Empty()
	crewed.Entries[shipID] = entry
	if err := (state.File{Path: at.State}).Save(crewed); err != nil {
		t.Fatal(err)
	}
	rules := `{"fleetId":"flt_01m3tb1zgr5h2ffee12xnch8sv","pluginShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","shipId":"` + shipID + `","settingsVersion":1,"sets":` + sets + `}`
	if err := (guardfile.Store{Guards: at.Guard}).Write(context.Background(), shipID, []byte(rules)); err != nil {
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
	return s.runTouch(t, marker, marker)
}

func (s *realContainerSession) runTouch(t *testing.T, target, marker string) realContainerResult {
	t.Helper()
	model := fakemodel.BashModel(t, "touch "+target)
	if err := os.MkdirAll(s.at.Proxy, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(modelproxy.FilesOf(s.at.Proxy).Port, []byte(model.URL[strings.LastIndex(model.URL, ":")+1:]), 0o600); err != nil {
		t.Fatal(err)
	}
	running, wired, _, logged := s.wire(t)
	harness, ok := wired["claude-code"].(claudecode.Harness)
	if !ok {
		t.Fatalf("claude-code is wired as %T, want claudecode.Harness", wired["claude-code"])
	}
	t.Cleanup(func() { _ = running.Stop(s.entry.ShipID) })

	if err := harness.Launch(s.entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	events := ""
	for until := time.Now().Add(150 * time.Second); time.Now().Before(until); time.Sleep(500 * time.Millisecond) {
		text, _ := os.ReadFile(hold.FilesOf(s.at.Sessions, s.entry.ShipID).Events)
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

func (s *realContainerSession) wire(t *testing.T) (container.Runtime, map[string]runpass.Harness, *shipsocket.Sockets, *lockedLog) {
	t.Helper()
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
	if _, err := opened.Open(s.entry.ShipID, s.entry.ShipFolder); err != nil {
		t.Fatal(err)
	}
	if s.isSocketClosed {
		opened.Close(s.entry.ShipID, s.entry.ShipFolder)
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
	return running, wired, opened, logged

}

func TestAContainerRequestWithHooksDisabledIsGivenBackBeforeItsSessionStarts(t *testing.T) {
	session := aRealContainerSession(t, realNoTouch)
	settings := filepath.Join(session.entry.Folder, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(`{"disableAllHooks":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	saved := state.File{Path: session.at.State}
	kept, err := saved.Load()
	if err != nil {
		t.Fatal(err)
	}
	entry := session.entry
	entry.State = "crewing"
	kept.Entries[entry.ShipID] = entry
	if err := saved.Save(kept); err != nil {
		t.Fatal(err)
	}

	type giveBack struct {
		ShipID          string
		SettingsVersion int
		Reason          string
	}
	givenBack := make(chan giveBack, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/fleet/assignedCrewRequests":
			_ = json.NewEncoder(w).Encode([]reconciler.Request{{ShipID: entry.ShipID, SettingsVersion: entry.SettingsVersion, Settings: reconciler.Settings{Harness: entry.Harness}}})
		case "/api/v1/fleet/clearRequests":
			_, _ = w.Write([]byte("[]"))
		case "/api/v1/ship/whoami":
			_, _ = w.Write([]byte(`{"name":"test-trierarch"}`))
		case "/api/v1/fleet/giveBackCrewRequest":
			var request giveBack
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			select {
			case givenBack <- request:
			default:
				t.Error("the request was given back more than once")
			}
			_, _ = w.Write([]byte("{}"))
		default:
			t.Errorf("unexpected fleet call before give-back: %s", r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(server.Close)
	running, wired, sockets, _ := session.wire(t)
	pass := runpass.Pass{
		Paths: session.at, Fleet: fleet.Client{URL: server.URL}, Sessions: onlyContainerSession{Runtime: running, shipID: entry.ShipID}, Harnesses: wired, Sockets: sockets,
		GuardRules: keptGuardRules{store: guardfile.Store{Guards: session.at.Guard}},
		Workspace:  workspace.Places{Root: session.at.Ships}, Store: saved,
		Log: func(line string) { t.Log(line) }, Now: time.Now, Offered: []string{entry.Harness}, RunningCap: 1,
		Offers:        func() map[string]map[string][]string { return nil },
		Configuration: func() map[string]config.Harness { return nil },
		Trusted:       func() map[string]reconciler.Trust { return nil },
	}
	if err := pass.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	select {
	case got := <-givenBack:
		if want := "test-trierarch: guard disabled by settings: " + settings; got.ShipID != entry.ShipID || got.SettingsVersion != entry.SettingsVersion || got.Reason != want {
			t.Fatalf("give-back = %+v, want ship %s, version %d, reason %q", got, entry.ShipID, entry.SettingsVersion, want)
		}
	default:
		t.Fatal("the fleet did not receive a give-back")
	}
	kept, err = saved.Load()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := kept.Entries[entry.ShipID]; ok {
		t.Fatal("the given-back entry is still kept")
	}
	if _, err := os.Stat(hold.FilesOf(session.at.Sessions, entry.ShipID).Events); !os.IsNotExist(err) {
		t.Fatalf("session events stat = %v, want no launch", err)
	}
}

// onlyContainerSession keeps reconciliation scoped to the test's ship on a shared Podman runtime.
type onlyContainerSession struct {
	container.Runtime
	shipID string
}

func (s onlyContainerSession) List() ([]sessions.Observed, error) {
	listed, err := s.Runtime.List()
	if err != nil {
		return nil, err
	}
	return slices.DeleteFunc(listed, func(each sessions.Observed) bool { return each.ShipID != s.shipID }), nil
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
