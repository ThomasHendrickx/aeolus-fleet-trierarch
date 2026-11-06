package container

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

const scout = "shp_01m6ny0nbtx4jc6hf1pqr2fx2f"

// aBinary is the runtime's binary as the container runtime calls it: what it was asked, and what it answers each command.
type aBinary struct {
	calls   []string
	answers map[string]string
	fails   map[string]bool
}

func (b *aBinary) run(args ...string) (string, error) {
	b.calls = append(b.calls, strings.Join(args, " "))
	if b.fails[args[0]] {
		return "", errors.New(args[0] + " failed")
	}
	return b.answers[args[0]], nil
}

func aContainerRuntime(t *testing.T) (Runtime, *aBinary) {
	t.Helper()
	home := t.TempDir()
	token := filepath.Join(home, "model-token")
	if err := os.WriteFile(token, []byte("sk-ant-oat01-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	binary := &aBinary{answers: map[string]string{}, fails: map[string]bool{}}
	return Runtime{
		Holds:      sessions.Runtime{Sessions: filepath.Join(home, "sessions"), Version: "1.2.3", BootedAt: func() time.Time { return time.Now().Add(-time.Hour) }},
		Binary:     "podman",
		Image:      "ghcr.io/thomashendrickx/aeolus-session:1.2.3",
		ModelToken: token,
		ProxyURL:   func() (string, bool) { return "http://127.0.0.1:41000", true },
		Homes:      filepath.Join(home, "homes"),
		Sockets:    filepath.Join(home, "sockets"),
		Memory:     "4g",
		Cpus:       2,
		Run:        binary.run,
	}, binary
}

func aSession(folder string) sessions.Start {
	return sessions.Start{ShipID: scout, Folder: folder, Harness: "claude-code", Command: []string{"claude", "-p"}, Env: map[string]string{"AEOLUS_LAUNCH": "launch-1"}}
}

func filesOf(t *testing.T, r Runtime) hold.Files {
	t.Helper()
	files := hold.FilesOf(r.Holds.Sessions, scout)
	if err := os.MkdirAll(files.Folder, 0o700); err != nil {
		t.Fatal(err)
	}
	return files
}

func modeOf(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

func TestTheHoldRunsTheSessionInAContainerOfItsOwnSeeingOnlyItsFolderHomeSocketAndReadOnlyCheckouts(t *testing.T) {
	r, _ := aContainerRuntime(t)
	files := filesOf(t, r)
	session := aSession("/worktrees/aeolus-fleet/scout")
	session.ReadOnly = []string{"/checkouts/" + scout + "/skills"}

	held, err := r.heldAs(session, files)

	home, sockets := filepath.Join(r.Homes, scout), filepath.Join(r.Sockets, scout)
	want := []string{
		"podman", "run", "--rm", "-i", "--name", "trierarch-" + scout, "--label", "aeolus.trierarch=aeolus-trierarch",
		"--memory-swap", "4g", "--memory", "4g", "--cpus", "2", "--pids-limit", "4096", "--userns=keep-id:uid=1000,gid=1000",
		"--device", "/dev/fuse", "--device", "/dev/net/tun", "--cap-add", "SYS_ADMIN", "--security-opt", "unmask=ALL",
		"--volume", "/worktrees/aeolus-fleet/scout:/worktrees/aeolus-fleet/scout", "--volume", home + ":/home/ubuntu", "--volume", sockets + ":" + sockets,
		"--volume", "/checkouts/" + scout + "/skills:/checkouts/" + scout + "/skills:ro",
		"--env", "HOME=/home/ubuntu", "--workdir", "/worktrees/aeolus-fleet/scout", "--env-file", filepath.Join(files.Folder, "session.env"),
		"ghcr.io/thomashendrickx/aeolus-session:1.2.3", "claude", "-p",
	}
	if err != nil || !reflect.DeepEqual(held.Command, want) || len(held.Env) != 0 {
		t.Fatalf("held as %q with %v, %v; want %q", held.Command, held.Env, err, want)
	}
}

func TestTheSessionsEnvironmentAndTheModelTokenGoInAnEnvFileOnlyItsOwnerReads(t *testing.T) {
	r, _ := aContainerRuntime(t)
	files := filesOf(t, r)

	held, err := r.heldAs(aSession(t.TempDir()), files)

	envFile := filepath.Join(files.Folder, "session.env")
	if got := readFile(t, envFile); err != nil || got != "AEOLUS_LAUNCH=launch-1\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-token\n" || modeOf(t, envFile) != 0o600 {
		t.Fatalf("env file %q (%v), %v", got, modeOf(t, envFile), err)
	}
	if strings.Contains(strings.Join(held.Command, " "), "sk-ant-oat01-token") {
		t.Fatalf("the model token is on the command line: %q", held.Command)
	}
}

func TestTheShipsHomeAndSocketFolderAreMadeForTheirOwnerAlone(t *testing.T) {
	r, _ := aContainerRuntime(t)

	if _, err := r.heldAs(aSession(t.TempDir()), filesOf(t, r)); err != nil {
		t.Fatal(err)
	}

	for _, folder := range []string{filepath.Join(r.Homes, scout), filepath.Join(r.Sockets, scout)} {
		if mode := modeOf(t, folder); mode != 0o700 {
			t.Errorf("%s has mode %v, want 0700", folder, mode)
		}
	}
}

func TestASessionOnAnAPIKeyGetsNoModelTokenAndOnlyItsProxyPort(t *testing.T) {
	r, _ := aContainerRuntime(t)
	files := filesOf(t, r)
	session := aSession(t.TempDir())
	session.ProxyToken = &sessions.ProxyToken{Harness: "claude-code", Variable: "ANTHROPIC_AUTH_TOKEN", Token: "proxy-token"}

	held, err := r.heldAs(session, files)

	if err != nil || strings.Contains(readFile(t, filepath.Join(files.Folder, "session.env")), "CLAUDE_CODE_OAUTH_TOKEN") {
		t.Fatalf("env file %q, %v", readFile(t, filepath.Join(files.Folder, "session.env")), err)
	}
	at := slices.Index(held.Command, "HOME=/home/ubuntu")
	if got := held.Command[at+1 : at+5]; !slices.Equal(got, []string{"--env", "ANTHROPIC_AUTH_TOKEN", "--network", "pasta:--no-map-gw,-t,none,-u,none,-T,41000,-U,none"}) || strings.Contains(strings.Join(held.Command, " "), "proxy-token") {
		t.Fatalf("held as %q", held.Command)
	}
}

func TestASessionOfMCPServersReachesOnlyItsProxyPortAndKeepsTheModelToken(t *testing.T) {
	r, _ := aContainerRuntime(t)
	files := filesOf(t, r)
	session := aSession(t.TempDir())
	session.Mcp = &sessions.Mcp{Access: mcpproxy.Access{Token: "mcp-token", Servers: []string{"company-graph"}}, Config: []byte(`{}`)}

	held, err := r.heldAs(session, files)

	if err != nil || !strings.Contains(readFile(t, filepath.Join(files.Folder, "session.env")), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-token") {
		t.Fatalf("env file %q, %v", readFile(t, filepath.Join(files.Folder, "session.env")), err)
	}
	at := slices.Index(held.Command, "--network")
	if at < 0 || held.Command[at+1] != "pasta:--no-map-gw,-t,none,-u,none,-T,41000,-U,none" || strings.Contains(strings.Join(held.Command, " "), "mcp-token") {
		t.Fatalf("held as %q, want only the proxy port forwarded and no token on the command line", held.Command)
	}
}

func TestASessionOfMCPServersSeesItsConfigurationOnlyReadOnlyAtItsOwnPath(t *testing.T) {
	r, _ := aContainerRuntime(t)
	files := filesOf(t, r)
	session := aSession(t.TempDir())
	session.Mcp = &sessions.Mcp{Access: mcpproxy.Access{Token: "mcp-token", Servers: []string{"company-graph"}}, Config: []byte(`{}`)}

	held, err := r.heldAs(session, files)

	mount := files.McpConfig + ":" + files.McpConfig + ":ro"
	if at := slices.Index(held.Command, mount); err != nil || at < 1 || held.Command[at-1] != "--volume" || slices.Contains(held.Command, files.Folder+":"+files.Folder) {
		t.Fatalf("held as %q, %v; want --volume %s and nothing else of the session's folder", held.Command, err, mount)
	}
}

func TestASessionOfNoMCPServersSeesNoConfiguration(t *testing.T) {
	r, _ := aContainerRuntime(t)
	files := filesOf(t, r)

	held, err := r.heldAs(aSession(t.TempDir()), files)

	if err != nil || strings.Contains(strings.Join(held.Command, " "), files.McpConfig) {
		t.Fatalf("held as %q, %v; want no MCP configuration mounted", held.Command, err)
	}
}

func TestAnEnvironmentValueOverMoreThanOneLineIsRefused(t *testing.T) {
	r, _ := aContainerRuntime(t)
	session := aSession(t.TempDir())
	session.Env["FIRST_PROMPT"] = "one\ntwo"

	if _, err := r.heldAs(session, filesOf(t, r)); err == nil {
		t.Fatal("an env file was written with a value over two lines")
	}
}

func TestAProxyURLIsReachedOnTheContainersLoopback(t *testing.T) {
	if got := ProxyURL("http://127.0.0.1:41234"); got != "http://127.0.0.1:41234" {
		t.Fatalf("ProxyURL = %q", got)
	}
}

func TestAContainerNoHoldHoldsIsListedAsOfAnotherVersion(t *testing.T) {
	r, binary := aContainerRuntime(t)
	other := "shp_01m6ny0nbtx4jc6hf1pqr2fx2g"
	binary.answers["ps"] = "trierarch-" + scout + " running\ntrierarch-" + other + " exited\nsomething-else running\n"

	listed, err := r.List()

	want := []sessions.Observed{{ShipID: scout, Status: "running", IsOtherVersion: true}, {ShipID: other, Status: "exited", IsOtherVersion: true}}
	if err != nil || !reflect.DeepEqual(listed, want) {
		t.Fatalf("List = %+v, %v; want %+v", listed, err, want)
	}
	if !slices.Equal(binary.calls, []string{"ps --all --filter label=aeolus.trierarch=aeolus-trierarch --format {{.Names}} {{.State}}"}) {
		t.Fatalf("asked %q", binary.calls)
	}
}

func TestAListTheRuntimeRefusesFails(t *testing.T) {
	r, binary := aContainerRuntime(t)
	binary.fails["ps"] = true

	if _, err := r.List(); err == nil {
		t.Fatal("List answered no error")
	}
}

func TestAStoppedSessionsContainerIsKilledThenRemoved(t *testing.T) {
	r, binary := aContainerRuntime(t)

	if err := r.Stop(scout); err != nil {
		t.Fatal(err)
	}

	if want := []string{"kill trierarch-" + scout, "rm --force trierarch-" + scout, "ps --all --filter label=aeolus.trierarch=aeolus-trierarch --format {{.Names}} {{.State}}"}; !slices.Equal(binary.calls, want) {
		t.Fatalf("asked %q, want %q", binary.calls, want)
	}
}

func TestAStopFailsWhileTheShipsContainerIsStillListedSoItsFolderIsNotRead(t *testing.T) {
	r, binary := aContainerRuntime(t)
	binary.fails["rm"] = true
	binary.answers["ps"] = "trierarch-" + scout + " running\n"

	err := r.Stop(scout)

	if err == nil || !strings.Contains(err.Error(), "the container of "+scout+" is still there after its stop: rm failed") {
		t.Fatalf("Stop = %v, want it to say the container is still there", err)
	}
}

func TestAStopFailsWhenTheContainersCannotBeListedAfterItSoItsFolderIsNotRead(t *testing.T) {
	r, binary := aContainerRuntime(t)
	binary.fails["ps"] = true

	if err := r.Stop(scout); err == nil {
		t.Fatal("Stop answered no error")
	}
}

func TestAShipWhoseContainerIsGoneIsStoppedWhateverItsKillAndRemoveSaid(t *testing.T) {
	r, binary := aContainerRuntime(t)
	binary.fails["kill"] = true
	binary.fails["rm"] = true

	if err := r.Stop(scout); err != nil {
		t.Fatalf("Stop = %v, want none", err)
	}
}

func TestTheSessionsRootIsItsContainersFirstProcess(t *testing.T) {
	tests := []struct {
		inspected string
		fails     bool
		want      int
	}{
		{"4242\n", false, 4242},
		{"0\n", false, 0},
		{"1\n", false, 0},
		{"", true, 0},
	}
	for _, test := range tests {
		r, binary := aContainerRuntime(t)
		binary.answers["inspect"] = test.inspected
		binary.fails["inspect"] = test.fails

		if got := r.Root(scout); got != test.want {
			t.Errorf("Root with inspect %q (fails %v) = %d, want %d", test.inspected, test.fails, got, test.want)
		}
		if !slices.Equal(binary.calls, []string{"inspect --format {{.State.Pid}} trierarch-" + scout}) {
			t.Errorf("asked %q", binary.calls)
		}
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}
