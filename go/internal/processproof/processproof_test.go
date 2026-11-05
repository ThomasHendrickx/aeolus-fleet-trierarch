package processproof

import (
	"os/exec"
	"testing"
)

func TestAProcessRunsTheWordsItWasStartedWith(t *testing.T) {
	// The shell keeps the words as arguments it ignores: macOS sleep refuses --folder and ends at once.
	process := exec.Command("sh", "-c", "while :; do sleep 1; done", "sleep", "30", "--folder", "/a/folder")
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = process.Process.Kill(); _ = process.Wait() })

	if !Runs(process.Process.Pid, "sleep", "30", "--folder", "/a/folder") {
		t.Fatal("Runs = false, want true for the words the process was started with")
	}
	if !Runs(process.Process.Pid, "--folder", "/a/folder") {
		t.Fatal("Runs = false, want true for words inside its command line")
	}
}

func TestAProcessRunsNotWordsItWasNotStartedWith(t *testing.T) {
	process := exec.Command("sleep", "30")
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = process.Process.Kill(); _ = process.Wait() })

	for _, words := range [][]string{{"hold", "shp_1"}, {"30", "sleep"}, {"slee"}, {"leep"}, {}} {
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
