package processproof

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

// TestMain makes the test binary a live process for the tests to inspect: started with the words, it sleeps, on every platform, where sleep itself takes other operands on macOS than on Linux.
func TestMain(m *testing.M) {
	if os.Getenv("PROCESSPROOF_SLEEP") != "" {
		time.Sleep(30 * time.Second)
		return
	}
	os.Exit(m.Run())
}

func startLive(t *testing.T, words ...string) *exec.Cmd {
	t.Helper()
	process := exec.Command(os.Args[0], words...)
	process.Env = append(os.Environ(), "PROCESSPROOF_SLEEP=1")
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = process.Process.Kill(); _ = process.Wait() })
	return process
}

func TestAProcessRunsTheWordsItWasStartedWith(t *testing.T) {
	process := startLive(t, "hold", "30", "--folder", "/a/folder")

	if !Runs(process.Process.Pid, "hold", "30", "--folder", "/a/folder") {
		t.Fatal("Runs = false, want true for the words the process was started with")
	}
	if !Runs(process.Process.Pid, "--folder", "/a/folder") {
		t.Fatal("Runs = false, want true for words inside its command line")
	}
}

func TestAProcessRunsNotWordsItWasNotStartedWith(t *testing.T) {
	process := startLive(t, "hold", "30")

	for _, words := range [][]string{{"hold", "shp_1"}, {"30", "hold"}, {"hol"}, {"old"}, {}} {
		if Runs(process.Process.Pid, words...) {
			t.Fatalf("Runs(%v) = true, want false", words)
		}
	}
}

func TestNoProcessRunsAnyWordsWhenItDoesNotExistOrIsNotAPid(t *testing.T) {
	for _, pid := range []int{0, 1, -5, 4194303} {
		if Runs(pid, "hold") {
			t.Fatalf("Runs(%d) = true, want false", pid)
		}
	}
}
