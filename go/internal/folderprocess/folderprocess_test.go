package folderprocess

import (
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// aProcessIn starts the command with its working folder the folder given, and answers it with a channel closed once it ended and was waited for.
func aProcessIn(t *testing.T, folder string, name string, args ...string) (*exec.Cmd, <-chan struct{}) {
	t.Helper()
	process := exec.Command(name, args...)
	process.Dir = folder
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	ended := make(chan struct{})
	go func() {
		_ = process.Wait()
		close(ended)
	}()
	t.Cleanup(func() {
		_ = process.Process.Kill()
		<-ended
	})
	return process, ended
}

// aFolder is a new folder under the name a process's working folder is given in: macOS keeps temporary folders under the symlink /var, and lsof says /private/var.
func aFolder(t *testing.T) string {
	t.Helper()
	folder, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return folder
}

func isEnded(ended <-chan struct{}, within time.Duration) bool {
	select {
	case <-ended:
		return true
	case <-time.After(within):
		return false
	}
}

func TestWhatRunsInAFolderIsAskedToEnd(t *testing.T) {
	folder := aFolder(t)
	_, ended := aProcessIn(t, folder, "sleep", "30")

	stopped, err := Stopper{Grace: 5 * time.Second}.StopIn(folder)

	if err != nil || stopped != 1 {
		t.Fatalf("StopIn(%s) = %d, %v, want 1, nil", folder, stopped, err)
	}
	if !isEnded(ended, time.Second) {
		t.Fatal("the process still runs")
	}
}

func TestWhatRunsInAFolderInsideItIsStoppedToo(t *testing.T) {
	folder := aFolder(t)
	inside := filepath.Join(folder, "app")
	if err := exec.Command("mkdir", inside).Run(); err != nil {
		t.Fatal(err)
	}
	_, ended := aProcessIn(t, inside, "sleep", "30")

	stopped, _ := Stopper{Grace: 5 * time.Second}.StopIn(folder)

	if stopped != 1 || !isEnded(ended, time.Second) {
		t.Fatalf("StopIn(%s) = %d, want 1 and the process ended", folder, stopped)
	}
}

func TestWhatDoesNotEndWithinTheGraceIsKilled(t *testing.T) {
	folder := aFolder(t)
	_, ended := aProcessIn(t, folder, "sh", "-c", `trap "" TERM; while :; do sleep 0.1; done`)
	time.Sleep(200 * time.Millisecond)

	stopped, _ := Stopper{Grace: 300 * time.Millisecond}.StopIn(folder)

	if stopped < 1 || !isEnded(ended, 2*time.Second) {
		t.Fatalf("StopIn(%s) = %d, want at least 1 and the process killed", folder, stopped)
	}
}

func TestWhatRunsElsewhereIsLeftRunning(t *testing.T) {
	folder := aFolder(t)
	_, ended := aProcessIn(t, aFolder(t), "sleep", "30")

	stopped, _ := Stopper{Grace: 5 * time.Second}.StopIn(folder)

	if stopped != 0 || isEnded(ended, 200*time.Millisecond) {
		t.Fatalf("StopIn(%s) = %d, want 0 and the process elsewhere running", folder, stopped)
	}
}

func TestAProcessIsInAFolderWhenItsFolderIsTheFolderOrInsideIt(t *testing.T) {
	for _, each := range []struct {
		processFolder string
		want          bool
	}{
		{"/worktrees/aeolus-fleet/stray", true},
		{"/worktrees/aeolus-fleet/stray/app", true},
		{"/worktrees/aeolus-fleet/stray (deleted)", true},
		{"/worktrees/aeolus-fleet/stray-two", false},
		{"/worktrees/aeolus-fleet", false},
	} {
		if got := IsInside(each.processFolder, "/worktrees/aeolus-fleet/stray"); got != each.want {
			t.Errorf("IsInside(%q) = %v, want %v", each.processFolder, got, each.want)
		}
	}
}

func TestTheWorkingFoldersLsofSaysAreReadByProcess(t *testing.T) {
	got := FoldersFromLsof("p12\nfcwd\nn/worktrees/aeolus-fleet/stray\np34\nfcwd\nn/home\n")

	want := []Folder{{PID: 12, Path: "/worktrees/aeolus-fleet/stray"}, {PID: 34, Path: "/home"}}
	if !slices.Equal(got, want) {
		t.Fatalf("FoldersFromLsof() = %v, want %v", got, want)
	}
}
