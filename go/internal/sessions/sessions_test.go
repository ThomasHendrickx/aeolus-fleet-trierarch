package sessions

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/aip"
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

func TestASessionsMCPAccessWithNoConfigurationKeepsNoConfigurationFile(t *testing.T) {
	runtime := aRuntime(t)
	folder := t.TempDir()
	files := hold.FilesOf(runtime.Sessions, scout)
	mcp := &Mcp{Access: mcpproxy.Access{Token: "scouts-mcp-token", Servers: []string{"company-graph"}}}
	if err := runtime.Start(Start{ShipID: scout, Folder: folder, Harness: "codex", Command: []string{"sh", "-c", aHarness}, Mcp: mcp}); err != nil {
		t.Fatalf("start: %v", err)
	}
	eventually(t, "the harness's pid", func() bool { _, err := os.Stat(filepath.Join(folder, "harness.pid")); return err == nil })

	if !strings.Contains(read(filepath.Join(files.Folder, "mcp-access")), "scouts-mcp-token") {
		t.Fatal("the session's folder keeps no MCP access with its token")
	}
	if _, err := os.Stat(files.McpConfig); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("%s: %v, want no MCP configuration file", files.McpConfig, err)
	}
}

func TestASessionsMCPConfigurationIsMode600EvenWhereAWiderFileWasBefore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp-config.json")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeMcpConfig(path, []byte(`{"mcpServers":{}}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("%s: %v, %v, want a file of mode 600", path, info, err)
	}
	if got := read(path); got != `{"mcpServers":{}}` {
		t.Fatalf("the MCP configuration = %q, want the one given", got)
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

// heldSecrets are the secrets the trierarch holds, by name.
type heldSecrets map[string]string

func (h heldSecrets) Value(name string) (string, bool) {
	value, ok := h[name]
	return value, ok
}

func TestEverySessionReachesTheAipServerWithItsReadTokenKeptInItsFolderNeverOnACommandLine(t *testing.T) {
	runtime := aRuntime(t)
	runtime.Aip = &Aip{Configured: &aip.Setting{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}, Secrets: heldSecrets{"aip-read": "scouts-aip-token"}}
	folder := started(t, runtime, aHarness)
	eventually(t, "the harness's environment", func() bool { return read(filepath.Join(folder, "harness.env")) != "" })

	env := read(filepath.Join(folder, "harness.env"))
	if !strings.Contains(env, "AIP_SERVER=https://aip.example.invalid") || !strings.Contains(env, "AIP_TOKEN=scouts-aip-token") {
		t.Fatalf("environment:\n%s\nwant AIP_SERVER and AIP_TOKEN", env)
	}
	files := hold.FilesOf(runtime.Sessions, scout)
	if info, err := os.Stat(files.SecretEnv); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("%s: %v, %v, want a file of mode 600", files.SecretEnv, info, err)
	}
	for _, pid := range []string{read(files.PID), read(filepath.Join(folder, "harness.pid"))} {
		if line := processOf(t, pid, "command"); strings.Contains(line, "scouts-aip-token") {
			t.Fatalf("the command line of %s holds the token: %q", pid, line)
		}
	}
}

func TestASessionWhoseAipTokenIsNotHeldReachesTheServerAloneAndTheSecretIsLoggedByNameAsNotHeld(t *testing.T) {
	runtime := aRuntime(t)
	logged := []string{}
	runtime.Aip = &Aip{Configured: &aip.Setting{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}, Secrets: heldSecrets{"another": "another-token"}, Log: func(line string) { logged = append(logged, line) }}
	folder := started(t, runtime, aHarness)
	eventually(t, "the harness's environment", func() bool { return read(filepath.Join(folder, "harness.env")) != "" })

	env := read(filepath.Join(folder, "harness.env"))
	if !strings.Contains(env, "AIP_SERVER=https://aip.example.invalid") || strings.Contains(env, "AIP_TOKEN") {
		t.Fatalf("environment:\n%s\nwant AIP_SERVER alone", env)
	}
	if len(logged) != 1 || !strings.Contains(logged[0], "aip-read") || strings.Contains(logged[0], "another-token") {
		t.Fatalf("logged %q, want one line naming the secret aip-read and no value", logged)
	}
}

// sent is the aip setting the trierarch plugin sent, as the aip file holds it.
func sent(setting aip.Setting) func() (aip.Setting, bool) {
	return func() (aip.Setting, bool) { return setting, true }
}

func TestASessionOfATrierarchWithNoAipConfiguredReachesTheAipServerTheTrierarchPluginSent(t *testing.T) {
	runtime := aRuntime(t)
	runtime.Aip = &Aip{Sent: sent(aip.Setting{Server: "https://aip.example.test", TokenSecret: "company-aip"}), Secrets: heldSecrets{"company-aip": "company-aip-token"}}
	folder := started(t, runtime, aHarness)
	eventually(t, "the harness's environment", func() bool { return read(filepath.Join(folder, "harness.env")) != "" })

	env := read(filepath.Join(folder, "harness.env"))
	if !strings.Contains(env, "AIP_SERVER=https://aip.example.test") || !strings.Contains(env, "AIP_TOKEN=company-aip-token") {
		t.Fatalf("environment:\n%s\nwant the sent AIP_SERVER and its AIP_TOKEN", env)
	}
}

func TestTheAipTheConfigurationNamesWinsOverTheOneTheTrierarchPluginSent(t *testing.T) {
	runtime := aRuntime(t)
	runtime.Aip = &Aip{Configured: &aip.Setting{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}, Sent: sent(aip.Setting{Server: "https://aip.example.test", TokenSecret: "company-aip"}), Secrets: heldSecrets{"aip-read": "scouts-aip-token", "company-aip": "company-aip-token"}}
	folder := started(t, runtime, aHarness)
	eventually(t, "the harness's environment", func() bool { return read(filepath.Join(folder, "harness.env")) != "" })

	env := read(filepath.Join(folder, "harness.env"))
	if !strings.Contains(env, "AIP_SERVER=https://aip.example.invalid") || !strings.Contains(env, "AIP_TOKEN=scouts-aip-token") || strings.Contains(env, "company-aip-token") {
		t.Fatalf("environment:\n%s\nwant the configured AIP_SERVER and its AIP_TOKEN alone", env)
	}
}

func TestASessionOfATrierarchWithNeitherAipConfiguredNorSentGetsNoAipVariables(t *testing.T) {
	runtime := aRuntime(t)
	runtime.Aip = &Aip{Sent: func() (aip.Setting, bool) { return aip.Setting{}, false }, Secrets: heldSecrets{"aip-read": "scouts-aip-token"}}
	folder := started(t, runtime, aHarness)
	eventually(t, "the harness's environment", func() bool { return read(filepath.Join(folder, "harness.env")) != "" })

	if env := read(filepath.Join(folder, "harness.env")); strings.Contains(env, "AIP_") {
		t.Fatalf("environment:\n%s\nwant no AIP variable", env)
	}
}

func TestASessionOfATrierarchWithNoAipServerGetsNoAipVariables(t *testing.T) {
	runtime := aRuntime(t)
	folder := started(t, runtime, aHarness)
	eventually(t, "the harness's environment", func() bool { return read(filepath.Join(folder, "harness.env")) != "" })

	if env := read(filepath.Join(folder, "harness.env")); strings.Contains(env, "AIP_") {
		t.Fatalf("environment:\n%s\nwant no AIP variable", env)
	}
}

// anAipCommand is a folder holding an aip that states the version, as the trierarch's aip folder's bin does.
func anAipCommand(t *testing.T, version string) func() (string, bool) {
	t.Helper()
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "aip"), []byte("#!/bin/sh\necho 'aip "+version+" format 0.6a1'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return func() (string, bool) { return bin, true }
}

// aHarnessRunningAip writes what `aip --version` says, or that there is no aip, then its environment.
const aHarnessRunningAip = `{ command -v aip > /dev/null && aip --version || echo "no aip"; } > aip-version; env > harness.env; while read -r line; do :; done`

func TestAHostSessionReachingAnAipServerRunsTheAipOfTheTrierarchsFolderFirstOnItsPath(t *testing.T) {
	runtime := aRuntime(t)
	command := anAipCommand(t, "0.7.0")
	runtime.Aip = &Aip{Configured: &aip.Setting{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}, Secrets: heldSecrets{}, Command: command, Path: "/usr/bin:/bin"}
	folder := started(t, runtime, aHarnessRunningAip)
	eventually(t, "the harness's environment", func() bool { return read(filepath.Join(folder, "harness.env")) != "" })

	bin, _ := command()
	if said := read(filepath.Join(folder, "aip-version")); said != "aip 0.7.0 format 0.6a1" {
		t.Errorf("aip --version = %q, want the trierarch's aip 0.7.0", said)
	}
	if env := read(filepath.Join(folder, "harness.env")); !strings.Contains("\n"+env+"\n", "\nPATH="+bin+":/usr/bin:/bin\n") {
		t.Errorf("environment:\n%s\nwant PATH=%s:/usr/bin:/bin", env, bin)
	}
}

func TestAHostSessionReachingNoAipServerKeepsThePathItHadWithoutAip(t *testing.T) {
	runtime := aRuntime(t)
	runtime.Aip = &Aip{Sent: func() (aip.Setting, bool) { return aip.Setting{}, false }, Secrets: heldSecrets{}, Command: anAipCommand(t, "0.7.0"), Path: "/usr/bin:/bin"}
	folder := started(t, runtime, aHarnessRunningAip)
	eventually(t, "the harness's environment", func() bool { return read(filepath.Join(folder, "harness.env")) != "" })

	if env := read(filepath.Join(folder, "harness.env")); !strings.Contains("\n"+env+"\n", "\nPATH="+os.Getenv("PATH")+"\n") {
		t.Errorf("environment:\n%s\nwant the hold's own PATH", env)
	}
}

func TestAHostSessionReachingAnAipServerWhileTheTrierarchHoldsNoAipKeepsThePathItHad(t *testing.T) {
	runtime := aRuntime(t)
	runtime.Aip = &Aip{Configured: &aip.Setting{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}, Secrets: heldSecrets{}, Command: func() (string, bool) { return "", false }, Path: "/usr/bin:/bin"}
	folder := started(t, runtime, aHarnessRunningAip)
	eventually(t, "the harness's environment", func() bool { return read(filepath.Join(folder, "harness.env")) != "" })

	if env := read(filepath.Join(folder, "harness.env")); !strings.Contains("\n"+env+"\n", "\nPATH="+os.Getenv("PATH")+"\n") || !strings.Contains(env, "AIP_SERVER=") {
		t.Errorf("environment:\n%s\nwant AIP_SERVER and the hold's own PATH", env)
	}
}

// commandGiven is the command a session's start hands its hold: what HeldAs is given, the hold then running a harness that only waits.
func commandGiven(t *testing.T, runtime Runtime, harness string) []string {
	t.Helper()
	var given []string
	runtime.HeldAs = func(session Start, files hold.Files) (Start, error) {
		given = session.Command
		session.Command = []string{"sh", "-c", "while read -r line; do :; done"}
		return session, nil
	}
	if err := runtime.Start(Start{ShipID: scout, Folder: t.TempDir(), Harness: harness, Command: []string{harness, "-p", "--mcp-config", "/sessions/mcp-config.json"}}); err != nil {
		t.Fatalf("start: %v", err)
	}
	return given
}

// aipsSkills is a plugin of aip's skills, as the trierarch's aip folder holds it.
func aipsSkills() (string, bool) { return "/home/scout/.aeolus/trierarch/aip-command/plugin", true }

func TestAHostClaudeCodeSessionReachingAnAipServerIsStartedWithThePluginOfAipsSkills(t *testing.T) {
	runtime := aRuntime(t)
	runtime.Aip = &Aip{Configured: &aip.Setting{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}, Secrets: heldSecrets{}, Command: anAipCommand(t, "0.7.0"), Plugin: aipsSkills, Path: "/usr/bin:/bin"}

	given := commandGiven(t, runtime, "claude-code")

	want := []string{"claude-code", "--plugin-dir", "/home/scout/.aeolus/trierarch/aip-command/plugin", "-p", "--mcp-config", "/sessions/mcp-config.json"}
	if !slices.Equal(given, want) {
		t.Errorf("command = %q, want %q", given, want)
	}
}

func TestAHostClaudeCodeSessionReachingNoAipServerGetsNoPluginOfAipsSkills(t *testing.T) {
	runtime := aRuntime(t)
	runtime.Aip = &Aip{Sent: func() (aip.Setting, bool) { return aip.Setting{}, false }, Secrets: heldSecrets{}, Command: anAipCommand(t, "0.7.0"), Plugin: aipsSkills, Path: "/usr/bin:/bin"}

	given := commandGiven(t, runtime, "claude-code")

	if want := []string{"claude-code", "-p", "--mcp-config", "/sessions/mcp-config.json"}; !slices.Equal(given, want) {
		t.Errorf("command = %q, want %q", given, want)
	}
}

func TestAHostClaudeCodeSessionWhileTheTrierarchHoldsNoAipsSkillsGetsNoPlugin(t *testing.T) {
	runtime := aRuntime(t)
	runtime.Aip = &Aip{Configured: &aip.Setting{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}, Secrets: heldSecrets{}, Command: anAipCommand(t, "0.7.0"), Plugin: func() (string, bool) { return "", false }, Path: "/usr/bin:/bin"}

	given := commandGiven(t, runtime, "claude-code")

	if want := []string{"claude-code", "-p", "--mcp-config", "/sessions/mcp-config.json"}; !slices.Equal(given, want) {
		t.Errorf("command = %q, want %q", given, want)
	}
}

func TestOnlyClaudeCodeSessionsAreStartedWithThePluginOfAipsSkills(t *testing.T) {
	for _, harness := range []string{"codex", "copilot"} {
		runtime := aRuntime(t)
		runtime.Aip = &Aip{Configured: &aip.Setting{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}, Secrets: heldSecrets{}, Command: anAipCommand(t, "0.7.0"), Plugin: aipsSkills, Path: "/usr/bin:/bin"}

		given := commandGiven(t, runtime, harness)

		if want := []string{harness, "-p", "--mcp-config", "/sessions/mcp-config.json"}; !slices.Equal(given, want) {
			t.Errorf("%s: command = %q, want %q", harness, given, want)
		}
	}
}

// TestARealClaudeCodeSessionListsAipsSkillsAndLeavesTheUsersOwnSettingsPluginsAndSkillsAsTheyWere runs the installed Claude Code under a hold, in
// a throwaway home, only with AEOLUS_TEST_CLAUDE_CODE=1: it needs no login, as its first event lists its skills before any model call.
func TestARealClaudeCodeSessionListsAipsSkillsAndLeavesTheUsersOwnSettingsPluginsAndSkillsAsTheyWere(t *testing.T) {
	if os.Getenv("AEOLUS_TEST_CLAUDE_CODE") != "1" {
		t.Skip("runs the installed Claude Code: only with AEOLUS_TEST_CLAUDE_CODE=1")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	own := map[string]string{
		filepath.Join(".claude", "settings.json"):                     `{"theme":"dark","enabledPlugins":{}}` + "\n",
		filepath.Join(".claude", "plugins", "installed_plugins.json"): `{"version":2,"plugins":{}}` + "\n",
		filepath.Join(".claude", "skills", "own-skill", "SKILL.md"):   "---\nname: own-skill\ndescription: the user's own skill\n---\n",
	}
	plugin := t.TempDir()
	files := map[string]string{
		filepath.Join(".claude-plugin", "plugin.json"):     `{"name":"aip","version":"0.7.0","description":"aip's own skills"}` + "\n",
		filepath.Join("skills", "aip-compile", "SKILL.md"): "---\nname: aip-compile\ndescription: compile skills\n---\n",
		filepath.Join("skills", "aip-runtime", "SKILL.md"): "---\nname: aip-runtime\ndescription: run procedures\n---\n",
	}
	for root, each := range map[string]map[string]string{home: own, plugin: files} {
		for name, text := range each {
			if err := os.MkdirAll(filepath.Dir(filepath.Join(root, name)), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	runtime := aRuntime(t)
	runtime.Aip = &Aip{Configured: &aip.Setting{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}, Secrets: heldSecrets{}, Command: anAipCommand(t, "0.7.0"), Plugin: func() (string, bool) { return plugin, true }, Path: os.Getenv("PATH")}
	if err := runtime.Start(Start{ShipID: scout, Folder: t.TempDir(), Harness: "claude-code", Command: []string{"claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"}}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Send(scout, `{"type":"user","message":{"role":"user","content":"ok"}}`); err != nil {
		t.Fatal(err)
	}

	var skills []string
	for until := time.Now().Add(60 * time.Second); skills == nil && time.Now().Before(until); time.Sleep(100 * time.Millisecond) {
		for _, line := range strings.Split(read(hold.FilesOf(runtime.Sessions, scout).Events), "\n") {
			var event struct {
				Type    string   `json:"type"`
				Subtype string   `json:"subtype"`
				Skills  []string `json:"skills"`
			}
			if json.Unmarshal([]byte(line), &event) == nil && event.Type == "system" && event.Subtype == "init" {
				skills = append([]string{}, event.Skills...)
			}
		}
	}
	for _, skill := range []string{"aip:aip-compile", "aip:aip-runtime", "own-skill"} {
		if !slices.Contains(skills, skill) {
			t.Errorf("the session lists the skills %q, want %s among them", skills, skill)
		}
	}
	_ = runtime.Stop(scout)
	for name, text := range own {
		if got := read(filepath.Join(home, name)); got != strings.TrimSpace(text) {
			t.Errorf("the user's %s = %q after the session, want it as it was: %q", name, got, text)
		}
	}
	if skillsFolder, _ := os.ReadDir(filepath.Join(home, ".claude", "skills")); len(skillsFolder) != 1 {
		t.Errorf("the user's skills folder holds %v after the session, want only own-skill", skillsFolder)
	}
	_ = filepath.WalkDir(filepath.Join(home, ".claude", "plugins"), func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() && strings.Contains(read(path), plugin) {
			t.Errorf("the user's %s names the plugin of aip's skills, want the user's plugins as they were", path)
		}
		return nil
	})
}
