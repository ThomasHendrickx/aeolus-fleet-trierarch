// Package folderprocess is the processes running in a folder (#1041), found
// by their working folder: a dev server a session started stays up after its
// ship is retired, and removing the folder under it would leave it running
// from nowhere. They are asked to end, and those still running after a grace
// period are killed.
package folderprocess

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Folder is a running process and the folder it works in.
type Folder struct {
	PID  int
	Path string
}

// grace is how long a process asked to end has before it is killed.
const grace = 5 * time.Second

const poll = 100 * time.Millisecond

// deletedSuffix is how Linux names the working folder of a process whose folder was removed.
const deletedSuffix = " (deleted)"

// FoldersFromLsof are the working folders `lsof -d cwd -Fpn` says: a `p` line names a process, the `n` line after it its folder.
func FoldersFromLsof(text string) []Folder {
	found := []Folder{}
	pid := 0
	for _, line := range strings.Split(text, "\n") {
		switch {
		case strings.HasPrefix(line, "p"):
			pid, _ = strconv.Atoi(line[1:])
		case strings.HasPrefix(line, "n") && pid != 0:
			found = append(found, Folder{PID: pid, Path: line[1:]})
		}
	}
	return found
}

// IsInside is whether the process's folder is the folder or inside it.
func IsInside(processFolder string, folder string) bool {
	own := strings.TrimSuffix(processFolder, deletedSuffix)
	return own == folder || strings.HasPrefix(own, strings.TrimSuffix(folder, string(filepath.Separator))+string(filepath.Separator))
}

// ProcessFolders are every process's working folder: from /proc where the machine has it, else from lsof (macOS).
func ProcessFolders() []Folder {
	names, err := os.ReadDir("/proc")
	if err != nil {
		listed, _ := exec.Command("lsof", "-d", "cwd", "-Fpn").Output()
		return FoldersFromLsof(string(listed))
	}
	found := []Folder{}
	for _, name := range names {
		pid, err := strconv.Atoi(name.Name())
		if err != nil {
			continue
		}
		// A process of another user, or one that ended since the listing, is not ours to stop.
		if path, err := os.Readlink(filepath.Join("/proc", name.Name(), "cwd")); err == nil {
			found = append(found, Folder{PID: pid, Path: path})
		}
	}
	return found
}

// Stopper stops what runs in a folder; its zero value reads every process's folder and gives each 5 seconds to end.
type Stopper struct {
	// Folders are the processes' working folders; none reads them from the machine.
	Folders func() []Folder
	Grace   time.Duration
}

func isAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// StopIn stops every process whose working folder is the folder or inside it, never the trierarch itself, and answers how many it stopped.
func (s Stopper) StopIn(folder string) (int, error) {
	folders, wait := s.Folders, s.Grace
	if folders == nil {
		folders = ProcessFolders
	}
	if wait == 0 {
		wait = grace
	}
	pids := []int{}
	for _, each := range folders() {
		if each.PID != os.Getpid() && IsInside(each.Path, folder) {
			pids = append(pids, each.PID)
		}
	}
	for _, pid := range pids {
		// One that ended already needs no asking.
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	for waited := time.Duration(0); waited < wait && anyAlive(pids); waited += poll {
		time.Sleep(poll)
	}
	for _, pid := range pids {
		if isAlive(pid) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	return len(pids), nil
}

func anyAlive(pids []int) bool {
	for _, pid := range pids {
		if isAlive(pid) {
			return true
		}
	}
	return false
}
