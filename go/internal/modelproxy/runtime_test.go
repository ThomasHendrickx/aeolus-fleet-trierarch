package modelproxy

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
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
	runtime := Runtime{Folder: filepath.Join(home, "proxy"), Sessions: filepath.Join(home, "sessions"), Keys: filepath.Join(home, "keys"), Program: []string{program}, Version: "1.2.3"}
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

	if isRunning(pid) {
		t.Fatalf("the proxy (pid %d) still runs, want it stopped", pid)
	}
	if _, err := os.Stat(filepath.Join(runtime.Folder, "proxy.pid")); err == nil {
		t.Fatal("the proxy's pid file stays, want it removed")
	}
}

func TestTheProxyCommandRefusesWordsItCannotTake(t *testing.T) {
	if code := Main([]string{"--folder", t.TempDir()}, "1.2.3"); code != 2 {
		t.Fatalf("Main without --sessions and --keys = %d, want 2", code)
	}
}
