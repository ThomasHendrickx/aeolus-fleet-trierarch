package modelproxy

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpconfiguration"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
)

// TestMain lets this test binary be the trierarch program the proxy is started as: `<binary> proxy ...`, of the version AEOLUS_TEST_PROXY_VERSION names.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "proxy" {
		version := os.Getenv("AEOLUS_TEST_PROXY_VERSION")
		if version == "" {
			version = "1.2.3"
		}
		os.Exit(Main(os.Args[2:], version))
	}
	os.Exit(m.Run())
}

func aRuntime(t *testing.T) Runtime {
	t.Helper()
	home := t.TempDir()
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	runtime := Runtime{Folder: filepath.Join(home, "proxy"), Sessions: filepath.Join(home, "sessions"), Keys: filepath.Join(home, "keys"), McpConfiguration: filepath.Join(home, "mcp-configuration.json"), Program: []string{program}, Version: "1.2.3"}
	t.Cleanup(func() { _ = runtime.Keep(false) })
	return runtime
}

func pidOf(t *testing.T, runtime Runtime) int {
	t.Helper()
	text, _ := os.ReadFile(filepath.Join(runtime.Folder, "proxy.pid"))
	pid, _ := strconv.Atoi(strings.TrimSpace(string(text)))
	return pid
}

func isRunning(pid int) bool {
	return pid > 1 && syscall.Kill(pid, 0) == nil
}

func versionAt(t *testing.T, address string) string {
	t.Helper()
	answer, err := http.Get(address + StatePath)
	if err != nil {
		return ""
	}
	defer answer.Body.Close()
	text := make([]byte, 64)
	n, _ := answer.Body.Read(text)
	return string(text[:n])
}

func TestANeededProxyRunsOnLoopbackAndSaysItsAddress(t *testing.T) {
	runtime := aRuntime(t)

	if err := runtime.Keep(true); err != nil {
		t.Fatal(err)
	}

	address, ok := runtime.URL()
	if !ok || !strings.HasPrefix(address, "http://127.0.0.1:") {
		t.Fatalf("URL() = %q, %v, want an address on loopback", address, ok)
	}
	if got := versionAt(t, address); got != `{"version":"1.2.3"}` {
		t.Fatalf("the proxy at %s answers %q, want its version", address, got)
	}
	info, err := os.Stat(runtime.Folder)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("mode of the proxy's folder = %v, %v, want 0700", info.Mode().Perm(), err)
	}
}

func TestARunningProxyOfThisVersionIsLeftAsItIs(t *testing.T) {
	runtime := aRuntime(t)
	if err := runtime.Keep(true); err != nil {
		t.Fatal(err)
	}
	before := pidOf(t, runtime)

	if err := runtime.Keep(true); err != nil {
		t.Fatal(err)
	}

	if after := pidOf(t, runtime); after != before || !isRunning(after) {
		t.Fatalf("pid after a second keep = %d, want %d still running", after, before)
	}
}

func TestAProxyThatIsGoneIsStartedAgainOnItsPort(t *testing.T) {
	runtime := aRuntime(t)
	if err := runtime.Keep(true); err != nil {
		t.Fatal(err)
	}
	address, _ := runtime.URL()
	before := pidOf(t, runtime)
	_ = syscall.Kill(before, syscall.SIGKILL)
	for isRunning(before) {
		time.Sleep(10 * time.Millisecond)
	}

	if err := runtime.Keep(true); err != nil {
		t.Fatal(err)
	}

	if after, _ := runtime.URL(); after != address || pidOf(t, runtime) == before {
		t.Fatalf("started again at %s (pid %d), want %s with a new pid", after, pidOf(t, runtime), address)
	}
}

func TestAProxyWhosePortIsTakenListensOnAnother(t *testing.T) {
	runtime := aRuntime(t)
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer taken.Close()
	port := strconv.Itoa(taken.Addr().(*net.TCPAddr).Port)
	if err := os.MkdirAll(runtime.Folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtime.Folder, "port"), []byte(port), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := runtime.Keep(true); err != nil {
		t.Fatal(err)
	}

	if address, ok := runtime.URL(); !ok || strings.HasSuffix(address, ":"+port) || versionAt(t, address) == "" {
		t.Fatalf("URL() = %q, want another port than the taken %s, answering", address, port)
	}
}

func TestAProxyAnotherVersionStartedIsReplaced(t *testing.T) {
	runtime := aRuntime(t)
	t.Setenv("AEOLUS_TEST_PROXY_VERSION", "1.2.2")
	if err := runtime.Keep(true); err != nil {
		t.Fatal(err)
	}
	before := pidOf(t, runtime)
	t.Setenv("AEOLUS_TEST_PROXY_VERSION", "1.2.3")

	if err := runtime.Keep(true); err != nil {
		t.Fatal(err)
	}

	address, _ := runtime.URL()
	if isRunning(before) || versionAt(t, address) != `{"version":"1.2.3"}` {
		t.Fatalf("after keep: old pid running %v, the proxy answers %q, want only this version's", isRunning(before), versionAt(t, address))
	}
}

func TestAProxyNoHarnessNeedsIsStopped(t *testing.T) {
	runtime := aRuntime(t)
	if err := runtime.Keep(true); err != nil {
		t.Fatal(err)
	}
	pid := pidOf(t, runtime)

	if err := runtime.Keep(false); err != nil {
		t.Fatal(err)
	}

	// A stopped process is gone once init reaps it, which a loaded machine delays.
	deadline := time.Now().Add(15 * time.Second)
	for isRunning(pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if isRunning(pid) {
		t.Fatalf("the proxy (pid %d) still runs 15 s after it was stopped, want it stopped", pid)
	}
	if _, err := os.Stat(filepath.Join(runtime.Folder, "proxy.pid")); err == nil {
		t.Fatal("the proxy's pid file stays, want it removed")
	}
}

func TestTheProxyCommandRefusesWordsItCannotTake(t *testing.T) {
	if code := Main([]string{"--folder", t.TempDir()}, "1.2.3"); code != 2 {
		t.Fatalf("Main without --sessions, --keys and --mcp-configuration = %d, want 2", code)
	}
}

func TestARunningProxyIsTheMCPProxyOfTheServersTheTrierarchPluginSentLast(t *testing.T) {
	graph := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"read_neo4j_cypher"},{"name":"write_neo4j_cypher"}]}}`)
	}))
	defer graph.Close()
	runtime := aRuntime(t)
	applyConfiguration(t, runtime.McpConfiguration, mcpservers.Server{Name: "company-graph", URL: graph.URL, Transport: mcpservers.Transport, Tools: []string{"read_neo4j_cypher"}}, nil)
	folder := filepath.Join(runtime.Sessions, scout)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "hold.pid"), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := mcpproxy.WriteAccess(folder, mcpproxy.Access{Token: "scouts-mcp-token", Servers: []string{"company-graph"}}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Keep(true); err != nil {
		t.Fatal(err)
	}
	address, _ := runtime.URL()

	request, _ := http.NewRequest(http.MethodPost, address+mcpproxy.PathOf(scout, "company-graph"), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	request.Header.Set("authorization", "Bearer scouts-mcp-token")
	answer, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer answer.Body.Close()
	text, _ := io.ReadAll(answer.Body)

	if want := `"tools":[{"name":"read_neo4j_cypher"}]`; !strings.Contains(string(text), want) {
		t.Fatalf("tools/list at the proxy = %d %s, want only %s", answer.StatusCode, text, want)
	}
}

// applyConfiguration applies a configuration of the server and secrets at the path, as the trierarch does.
func applyConfiguration(t *testing.T, path string, server mcpservers.Server, held map[string]string) {
	t.Helper()
	if held == nil {
		held = map[string]string{}
	}
	identity := mcpconfiguration.Identity{FleetID: "flt_01m3tb1zgr5h2ffee12xnch8sv", PluginShipID: "shp_01m3tb1zhjs6kthtcs2zvksacv"}
	file := &mcpconfiguration.File{Path: path}
	file.Load(identity)
	if _, err := file.Apply(mcpconfiguration.Configuration{Identity: identity, Version: 1, PublicKey: "key-a", Servers: []mcpservers.Server{server}, Secrets: held}); err != nil {
		t.Fatal(err)
	}
}

func TestTheProxyCommandRefusesWordsWithoutTheMcpConfiguration(t *testing.T) {
	home := t.TempDir()
	words := []string{"--folder", filepath.Join(home, "proxy"), "--sessions", filepath.Join(home, "sessions"), "--keys", filepath.Join(home, "keys"), "--mcp-servers", filepath.Join(home, "mcp-servers.json")}

	if code := Main(words, "1.2.3"); code != 2 {
		t.Fatalf("Main with --mcp-servers in place of --mcp-configuration = %d, want 2", code)
	}
}

func TestARunningProxyAddsTheCredentialOfTheSecretsTheTrierarchKeeps(t *testing.T) {
	var got []string
	graph := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Get("authorization"))
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`)
	}))
	defer graph.Close()
	runtime := aRuntime(t)
	applyConfiguration(t, runtime.McpConfiguration, mcpservers.Server{Name: "company-graph", URL: graph.URL, Transport: mcpservers.Transport, Tools: []string{"read_neo4j_cypher"}, Credential: &mcpservers.Credential{Secret: "graph-token", Header: "Authorization"}}, map[string]string{"graph-token": "Bearer s3cr3t"})
	folder := filepath.Join(runtime.Sessions, scout)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "hold.pid"), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := mcpproxy.WriteAccess(folder, mcpproxy.Access{Token: "scouts-mcp-token", Servers: []string{"company-graph"}}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Keep(true); err != nil {
		t.Fatal(err)
	}
	address, _ := runtime.URL()

	request, _ := http.NewRequest(http.MethodPost, address+mcpproxy.PathOf(scout, "company-graph"), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	request.Header.Set("authorization", "Bearer scouts-mcp-token")
	answer, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = answer.Body.Close()

	if answer.StatusCode != http.StatusOK || !slices.Equal(got, []string{"Bearer s3cr3t"}) {
		t.Fatalf("tools/list at the proxy = %d, the graph got authorization %q, want Bearer s3cr3t", answer.StatusCode, got)
	}
}

func TestAPidFileNamingAnUnrelatedLiveProcessSignalsNothing(t *testing.T) {
	runtime := aRuntime(t)
	unrelated := exec.Command("sleep", "60")
	if err := unrelated.Start(); err != nil {
		t.Fatal(err)
	}
	ended := make(chan struct{})
	go func() { _ = unrelated.Wait(); close(ended) }()
	t.Cleanup(func() { _ = unrelated.Process.Kill(); <-ended })
	if err := os.MkdirAll(runtime.Folder, 0o700); err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(runtime.Folder, "proxy.pid")
	if err := os.WriteFile(pidFile, []byte(strconv.Itoa(unrelated.Process.Pid)), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := runtime.Keep(false); err != nil {
		t.Fatalf("Keep(false) = %v", err)
	}

	select {
	case <-ended:
		t.Fatalf("the unrelated process (pid %d) was signalled", unrelated.Process.Pid)
	case <-time.After(200 * time.Millisecond):
	}
	if _, err := os.Stat(pidFile); err == nil {
		t.Fatal("the stale pid file stays, want it removed")
	}
}
