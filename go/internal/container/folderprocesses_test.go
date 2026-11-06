package container

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// hostProcesses are the processes on the host, which stop as many as they are set to, and note each folder they were asked to stop in.
type hostProcesses struct {
	stopped int
	asked   []string
}

func (h *hostProcesses) StopIn(folder string) (int, error) {
	h.asked = append(h.asked, folder)
	return h.stopped, nil
}

// listingFor is the runtime's binary listing the containers as the answer for the folder a listing filters on says.
func listingFor(answer func(volume string) (string, error)) func(args ...string) (string, error) {
	return func(args ...string) (string, error) {
		for _, arg := range args {
			if volume, ok := strings.CutPrefix(arg, "volume="); ok && args[0] == "ps" {
				return answer(volume)
			}
		}
		return "", nil
	}
}

func aShipsFolder(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(root, "aeolus-fleet", "scout")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	return folder
}

func TestTheProcessesOnTheHostAreStoppedInAFolderNoContainerWorksIn(t *testing.T) {
	folder := aShipsFolder(t)
	host := &hostProcesses{stopped: 2}
	processes := FolderProcesses{Runtime: Runtime{Run: listingFor(func(string) (string, error) { return "", nil })}, Host: host}

	stopped, err := processes.StopIn(folder)

	if err != nil || stopped != 2 || !slices.Equal(host.asked, []string{folder}) {
		t.Fatalf("StopIn(%s) = %d, %v, asked %q; want 2, none, the folder", folder, stopped, err, host.asked)
	}
}

func TestAFolderAContainerWorksInIsLeftForTheNextPassAndNothingStopped(t *testing.T) {
	folder := aShipsFolder(t)
	host := &hostProcesses{stopped: 2}
	processes := FolderProcesses{Runtime: Runtime{Run: listingFor(func(volume string) (string, error) {
		if volume == folder {
			return "trierarch-" + scout + " running\n", nil
		}
		return "", nil
	})}, Host: host}

	_, err := processes.StopIn(folder)

	if err == nil || !strings.Contains(err.Error(), "a container works in "+folder+", so it is left for the next pass: trierarch-"+scout) || len(host.asked) > 0 {
		t.Fatalf("StopIn(%s) = %v, asked %q; want it left, saying which container, and nothing stopped", folder, err, host.asked)
	}
}

func TestAFolderAContainerWorksInByItsRealPathIsLeftWhenReachedOverALink(t *testing.T) {
	folder := aShipsFolder(t)
	linked := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(filepath.Dir(filepath.Dir(folder)), linked); err != nil {
		t.Fatal(err)
	}
	processes := FolderProcesses{Runtime: Runtime{Run: listingFor(func(volume string) (string, error) {
		if volume == folder {
			return "trierarch-" + scout + " running\n", nil
		}
		return "", nil
	})}, Host: &hostProcesses{}}

	if _, err := processes.StopIn(filepath.Join(linked, "aeolus-fleet", "scout")); err == nil {
		t.Fatal("StopIn over a link answered no error")
	}
}

func TestAFolderIsLeftForTheNextPassWhenTheRuntimeCannotTellWhetherAContainerWorksInIt(t *testing.T) {
	folder := aShipsFolder(t)
	host := &hostProcesses{}
	processes := FolderProcesses{Runtime: Runtime{Run: listingFor(func(string) (string, error) { return "", errors.New("ps failed") })}, Host: host}

	_, err := processes.StopIn(folder)

	if err == nil || !strings.Contains(err.Error(), "cannot tell whether a container works in "+folder) || len(host.asked) > 0 {
		t.Fatalf("StopIn(%s) = %v, asked %q; want it left and nothing stopped", folder, err, host.asked)
	}
}

func TestTheProcessesOnTheHostAreStoppedInAFolderOnlyAnExitedContainerHad(t *testing.T) {
	folder := aShipsFolder(t)
	processes := FolderProcesses{Runtime: Runtime{Run: listingFor(func(string) (string, error) { return "trierarch-" + scout + " exited\n", nil })}, Host: &hostProcesses{stopped: 1}}

	if stopped, err := processes.StopIn(folder); err != nil || stopped != 1 {
		t.Fatalf("StopIn(%s) = %d, %v; want 1, none", folder, stopped, err)
	}
}
