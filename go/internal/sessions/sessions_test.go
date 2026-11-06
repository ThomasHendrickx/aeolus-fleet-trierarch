package sessions

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/proxytoken"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"

// TestMain lets this test binary be the trierarch program a hold is started as: `<binary> hold ...`.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "hold" {
		os.Exit(hold.Main(os.Args[2:], "1.2.3", os.Environ()))
	}
	os.Exit(m.Run())
}

// aHarness writes its pid and environment into its folder, then answers each line with a result.
const aHarness = `echo $$ > harness.pid; env > harness.env; while read -r line; do echo "{\"type\":\"result\",\"got\":$line}"; done`

func aRuntime(t *testing.T) Runtime {
	t.Helper()
	sessions, err := os.MkdirTemp("", "sessions")
	if err != nil {
		t.Fatal(err)
	}
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	runtime := Runtime{Sessions: sessions, Program: []string{program}, Version: "1.2.3", BootedAt: func() time.Time { return time.Now().Add(-time.Hour) }}
	t.Cleanup(func() {
		_ = runtime.Stop(scout)
		_ = os.RemoveAll(sessions)
	})
	return runtime
}

func started(t *testing.T, runtime Runtime, script string) string {
	t.Helper()
	folder := t.TempDir()
	if err := runtime.Start(Start{ShipID: scout, Folder: folder, Harness: "claude-code", Command: []string{"sh", "-c", script}, Env: map[string]string{"AEOLUS_LAUNCH": "launch-1"}}); err != nil {
		t.Fatalf("start: %v", err)
	}
	return folder
}

func eventually(t *testing.T, what string, isIt func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !isIt() {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not happen within 5 s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func read(path string) string {
	text, _ := os.ReadFile(path)
	return strings.TrimSpace(string(text))
}

// processOf is a field of the running process as ps says it, on Linux and macOS alike, which has no /proc.
func processOf(t *testing.T, pid string, field string) string {
	t.Helper()
	said, err := exec.Command("ps", "-o", field+"=", "-p", pid).Output()
	if err != nil {
		t.Fatalf("ps -o %s= -p %s: %v", field, pid, err)
	}
	return strings.TrimSpace(string(said))
}

func listed(t *testing.T, runtime Runtime) []Observed {
	t.Helper()
	sessions, err := runtime.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	return sessions
}

func TestAStartedSessionIsListedRunning(t *testing.T) {
	runtime := aRuntime(t)
	started(t, runtime, aHarness)

	sessions := listed(t, runtime)

	if len(sessions) != 1 || sessions[0].ShipID != scout || sessions[0].Status != "running" {
		t.Fatalf("listed: %+v", sessions)
	}
}

func TestTheSessionRunsUnderAHoldThatIsNoChildOfTheTrierarch(t *testing.T) {
	runtime := aRuntime(t)
	folder := started(t, runtime, aHarness)
	eventually(t, "the harness's pid", func() bool { return read(filepath.Join(folder, "harness.pid")) != "" })

	holdPID := read(hold.FilesOf(runtime.Sessions, scout).PID)

	if parent := processOf(t, read(filepath.Join(folder, "harness.pid")), "ppid"); parent != holdPID {
		t.Fatalf("the harness's parent is %q, not the hold %s", parent, holdPID)
	}
	if parent := processOf(t, holdPID, "ppid"); parent == strconv.Itoa(os.Getpid()) {
		t.Fatalf("the hold %s is the trierarch's child", holdPID)
	}
}

func TestTheHarnessGetsOnlyTheHoldsFewVariablesAndThoseGiven(t *testing.T) {
	t.Setenv("AEOLUS_TRIERARCH_CONFIG", "/secret/config.json")
	runtime := aRuntime(t)
	folder := started(t, runtime, aHarness)
	eventually(t, "the harness's environment", func() bool { return read(filepath.Join(folder, "harness.env")) != "" })

	env := read(filepath.Join(folder, "harness.env"))

	if !strings.Contains(env, "AEOLUS_LAUNCH=launch-1") || strings.Contains(env, "AEOLUS_TRIERARCH_CONFIG") || !strings.Contains(env, "PATH=") {
		t.Fatalf("environment:\n%s", env)
	}
}

func TestALineSentReachesTheHarness(t *testing.T) {
	runtime := aRuntime(t)
	started(t, runtime, aHarness)

	if err := runtime.Send(scout, `{"type":"user"}`); err != nil {
		t.Fatalf("send: %v", err)
	}

	eventually(t, "the result in the events", func() bool {
		return strings.Contains(read(hold.FilesOf(runtime.Sessions, scout).Events), `"got":{"type":"user"}`)
	})
}

func TestASessionWhoseHarnessEndedIsListedExited(t *testing.T) {
	runtime := aRuntime(t)
	started(t, runtime, `read -r line; exit 1`)

	if err := runtime.Send(scout, "{}"); err != nil {
		t.Fatalf("send: %v", err)
	}

	eventually(t, "the session listed exited", func() bool {
		sessions := listed(t, runtime)
		return len(sessions) == 1 && sessions[0].Status == "exited"
	})
}

func TestAHoldFromBeforeTheMachineStartedIsNotListed(t *testing.T) {
	runtime := aRuntime(t)
	started(t, runtime, `read -r line; exit 1`)
	if err := runtime.Send(scout, "{}"); err != nil {
		t.Fatalf("send: %v", err)
	}
	runtime.BootedAt = func() time.Time { return time.Now().Add(time.Hour) }

	eventually(t, "the session gone from the list", func() bool { return len(listed(t, runtime)) == 0 })
}

func TestAStoppedSessionEndsWithItsHoldAndItsFilesGo(t *testing.T) {
	runtime := aRuntime(t)
	folder := started(t, runtime, aHarness)
	eventually(t, "the harness's pid", func() bool { return read(filepath.Join(folder, "harness.pid")) != "" })
	harness := read(filepath.Join(folder, "harness.pid"))

	if err := runtime.Stop(scout); err != nil {
		t.Fatalf("stop: %v", err)
	}

	if _, err := os.Stat(hold.FilesOf(runtime.Sessions, scout).Folder); err == nil {
		t.Fatalf("the session's files stayed")
	}
	if len(listed(t, runtime)) != 0 {
		t.Fatalf("still listed")
	}
	eventually(t, "the harness ended", func() bool {
		pid := 0
		for _, digit := range harness {
			pid = pid*10 + int(digit-'0')
		}
		return syscall.Kill(pid, 0) != nil
	})
}

func TestStoppingASessionThatRunsNotIsNoError(t *testing.T) {
	runtime := aRuntime(t)

	if err := runtime.Stop(scout); err != nil {
		t.Fatalf("stop: %v", err)
	}
}

func TestUnderASystemdUnitAHoldStartsInAScopeOfItsOwnExpandingNothingFrom254(t *testing.T) {
	cases := []struct {
		platform, invocation string
		version              int
		want                 string
	}{
		{"linux", "abc", 254, "systemd-run --user --scope --quiet --collect --expand-environment=no --"},
		{"linux", "abc", 253, "systemd-run --user --scope --quiet --collect --"},
		{"linux", "", 259, ""},
		{"darwin", "abc", 259, ""},
	}
	for _, each := range cases {
		if got := strings.Join(Launch(each.platform, each.invocation, each.version), " "); got != each.want {
			t.Errorf("%+v: %q", each, got)
		}
	}
}

// aClaudeCodeHarness answers a turn per line but one saying slowly, which runs until the interrupt control request ends it.
const aClaudeCodeHarness = `while read -r line; do case "$line" in *control_request*) echo '{"type":"control_response","response":{"subtype":"success","request_id":"aeolus-interrupt-1"}}'; echo '{"type":"result","subtype":"error_during_execution"}' ;; *slowly*) : ;; *) echo '{"type":"result","subtype":"success"}' ;; esac; done`

func TestAnInterruptStopsTheSessionsBusyTurn(t *testing.T) {
	runtime := aRuntime(t)
	started(t, runtime, aClaudeCodeHarness)
	if err := runtime.Send(scout, `{"type":"user","text":"slowly"}`); err != nil {
		t.Fatal(err)
	}

	if err := runtime.Interrupt(scout); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}

	events, _ := os.ReadFile(hold.FilesOf(runtime.Sessions, scout).Events)
	if !strings.Contains(string(events), "error_during_execution") {
		t.Fatalf("events = %s, want the turn ended by the interrupt", events)
	}
}

func TestASessionAnotherVersionHoldsIsListedAsOfAnotherVersion(t *testing.T) {
	runtime := aRuntime(t)
	started(t, runtime, aHarness)
	runtime.Version = "9.9.9"

	listed, err := runtime.List()

	if err != nil || len(listed) != 1 || !listed[0].IsOtherVersion || listed[0].Status != "running" {
		t.Fatalf("List = %+v %v, want the session running, of another version", listed, err)
	}
}

func TestASessionOfThisVersionIsNotOfAnotherVersion(t *testing.T) {
	runtime := aRuntime(t)
	started(t, runtime, aHarness)

	listed, err := runtime.List()

	if err != nil || len(listed) != 1 || listed[0].IsOtherVersion {
		t.Fatalf("List = %+v %v, want the session of this version", listed, err)
	}
}

func TestTheRootOfASessionIsItsHold(t *testing.T) {
	runtime := aRuntime(t)
	folder := started(t, runtime, aHarness)
	eventually(t, "the harness's pid", func() bool { _, err := os.Stat(filepath.Join(folder, "harness.pid")); return err == nil })
	pid, _ := os.ReadFile(hold.FilesOf(runtime.Sessions, scout).PID)

	if got := runtime.Root(scout); strconv.Itoa(got) != strings.TrimSpace(string(pid)) {
		t.Fatalf("Root = %d, want the hold's pid %s", got, pid)
	}
	if got := runtime.Root("shp_01m6jyczpnpp5c0vxh54c966cz"); got != 0 {
		t.Fatalf("Root of a ship with no session = %d, want 0", got)
	}
}

func TestASessionsProxyTokenIsKeptInItsFolderAndHandedToItsHarnessInItsVariableNeverOnACommandLine(t *testing.T) {
	runtime := aRuntime(t)
	folder := t.TempDir()
	token := &ProxyToken{Harness: "claude-code", Variable: "ANTHROPIC_AUTH_TOKEN", Token: "scouts-proxy-token"}
	if err := runtime.Start(Start{ShipID: scout, Folder: folder, Harness: "claude-code", Command: []string{"sh", "-c", aHarness}, Env: map[string]string{"ANTHROPIC_BASE_URL": "http://127.0.0.1:1/anthropic"}, ProxyToken: token}); err != nil {
		t.Fatalf("start: %v", err)
	}
	eventually(t, "the harness's environment", func() bool { return read(filepath.Join(folder, "harness.env")) != "" })

	env := read(filepath.Join(folder, "harness.env"))
	if !strings.Contains(env, "ANTHROPIC_AUTH_TOKEN=scouts-proxy-token") || !strings.Contains(env, "ANTHROPIC_BASE_URL=http://127.0.0.1:1/anthropic") {
		t.Fatalf("environment:\n%s", env)
	}
	kept, ok := proxytoken.Read(hold.FilesOf(runtime.Sessions, scout).Folder)
	if !ok || kept != (proxytoken.Token{Harness: "claude-code", Token: "scouts-proxy-token"}) {
		t.Fatalf("the session's folder keeps %+v, %v, want its token", kept, ok)
	}
	for _, pid := range []string{read(hold.FilesOf(runtime.Sessions, scout).PID), read(filepath.Join(folder, "harness.pid"))} {
		if line := processOf(t, pid, "command"); strings.Contains(line, "scouts-proxy-token") {
			t.Fatalf("the command line of %s holds the token: %q", pid, line)
		}
	}
}

func TestASessionsMCPAccessAndConfigurationAreKeptInItsFolderForItsUserOnlyNeverOnACommandLine(t *testing.T) {
	runtime := aRuntime(t)
	folder := t.TempDir()
	files := hold.FilesOf(runtime.Sessions, scout)
	mcp := &Mcp{Access: mcpproxy.Access{Token: "scouts-mcp-token", Servers: []string{"company-graph"}}, Config: []byte(`{"mcpServers":{}}`)}
	if err := runtime.Start(Start{ShipID: scout, Folder: folder, Harness: "claude-code", Command: []string{"sh", "-c", aHarness, "sh", "--mcp-config", files.McpConfig}, Mcp: mcp}); err != nil {
		t.Fatalf("start: %v", err)
	}
	eventually(t, "the harness's pid", func() bool { _, err := os.Stat(filepath.Join(folder, "harness.pid")); return err == nil })

	for _, path := range []string{files.McpConfig, filepath.Join(files.Folder, "mcp-access")} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v, %v, want a file of mode 600", path, info, err)
		}
	}
	if got := read(files.McpConfig); got != `{"mcpServers":{}}` {
		t.Fatalf("the MCP configuration = %q, want the one given", got)
	}
	if !strings.Contains(read(filepath.Join(files.Folder, "mcp-access")), "scouts-mcp-token") {
		t.Fatal("the session's folder keeps no MCP access with its token")
	}
	for _, pid := range []string{read(files.PID), read(filepath.Join(folder, "harness.pid"))} {
		if line := processOf(t, pid, "command"); strings.Contains(line, "scouts-mcp-token") {
			t.Fatalf("the command line of %s holds the token: %q", pid, line)
		}
	}
}

func TestALineSentToACodexSessionWaitsForItsLastTurnToEndAsLongAsForAnInterruptedTurn(t *testing.T) {
	runtime := aRuntime(t)
	folder := t.TempDir()
	turn := `cat > /dev/null; echo '{"type":"thread.started","thread_id":"thread-1"}'; case "$*" in *first*) sleep 3 ;; esac; echo "$*" >> turns`
	if err := runtime.Start(Start{ShipID: scout, Folder: folder, Harness: "codex", Command: []string{"sh", "-c", turn, "sh", "exec", "--json", "--", "first"}}); err != nil {
		t.Fatalf("start: %v", err)
	}

	if err := runtime.Send(scout, "hello"); err != nil {
		t.Fatalf("Send = %v, want the line's turn started once the first turn ended", err)
	}
	eventually(t, "the line's turn", func() bool { return strings.Contains(read(filepath.Join(folder, "turns")), "-- hello") })
}

func TestAPidFileNamingAnUnrelatedLiveProcessSignalsNothingAndIsNoRoot(t *testing.T) {
	runtime := aRuntime(t)
	unrelated := exec.Command("sleep", "60")
	if err := unrelated.Start(); err != nil {
		t.Fatal(err)
	}
	ended := make(chan struct{})
	go func() { _ = unrelated.Wait(); close(ended) }()
	t.Cleanup(func() { _ = unrelated.Process.Kill(); <-ended })
	files := hold.FilesOf(runtime.Sessions, scout)
	if err := os.MkdirAll(files.Folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(files.PID, []byte(strconv.Itoa(unrelated.Process.Pid)), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := runtime.Root(scout); got != 0 {
		t.Fatalf("Root = %d, want 0 for a pid that is not the ship's hold", got)
	}
	if err := runtime.Stop(scout); err != nil {
		t.Fatalf("Stop = %v", err)
	}

	select {
	case <-ended:
		t.Fatalf("the unrelated process (pid %d) was signalled", unrelated.Process.Pid)
	case <-time.After(200 * time.Millisecond):
	}
	if _, err := os.Stat(files.Folder); err == nil {
		t.Fatal("the session's folder stays, want it removed")
	}
}

func TestHeldAsReplacesWhatTheHoldRunsOnceTheShipsLastSessionStoppedAndItsFolderIsNew(t *testing.T) {
	runtime := aRuntime(t)
	folder := t.TempDir()
	var given Start
	runtime.HeldAs = func(session Start, files hold.Files) (Start, error) {
		given = session
		if err := os.WriteFile(filepath.Join(files.Folder, "held-as"), []byte("kept"), 0o600); err != nil {
			return Start{}, err
		}
		session.Command = []string{"sh", "-c", "cat " + filepath.Join(files.Folder, "held-as") + " > held.txt; env > harness.env; " + aHarness}
		session.Env = map[string]string{}
		return session, nil
	}

	if err := runtime.Start(Start{ShipID: scout, Folder: folder, Harness: "claude-code", Command: []string{"claude"}, Env: map[string]string{"AEOLUS_LAUNCH": "launch-1"}}); err != nil {
		t.Fatal(err)
	}

	eventually(t, "the held command's output", func() bool {
		return read(filepath.Join(folder, "held.txt")) != "" && read(filepath.Join(folder, "harness.env")) != ""
	})
	if got := read(filepath.Join(folder, "held.txt")); got != "kept" || given.Command[0] != "claude" {
		t.Fatalf("held %q, given %q", got, given.Command)
	}
	if env := read(filepath.Join(folder, "harness.env")); strings.Contains(env, "AEOLUS_LAUNCH") {
		t.Fatalf("the hold was given the session's own environment:\n%s", env)
	}
}
