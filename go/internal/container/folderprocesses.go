package container

import (
	"fmt"
	"path/filepath"
	"strings"
)

// HostProcesses are the processes on the host whose working folder is in a folder.
type HostProcesses interface {
	// StopIn stops every process whose working folder is the folder or inside it, and answers how many it stopped.
	StopIn(folder string) (int, error)
}

// runsNothing are the states of a container that runs nothing, as Podman and Docker name them.
var runsNothing = map[string]bool{"exited": true, "stopped": true, "dead": true}

// FolderProcesses are the processes running in a folder when sessions run in containers (#1041): a container's processes are no
// process the host finds by its working folder, and while one runs with the folder mounted its session can still write the folder,
// `.git` included. So the host stops what runs in a folder, and then reads it, only once no container works in it: one that does,
// or a runtime that cannot say, leaves the folder for the next pass.
type FolderProcesses struct {
	Runtime Runtime
	Host    HostProcesses
}

// StopIn stops the processes on the host in the folder once no container works in it, by its path or, as a container mounts it, its real path.
func (f FolderProcesses) StopIn(folder string) (int, error) {
	paths := []string{folder}
	if real, err := filepath.EvalSymlinks(folder); err == nil && real != folder {
		paths = append(paths, real)
	}
	for _, path := range paths {
		working, err := f.workingIn(path)
		if err != nil {
			return 0, fmt.Errorf("cannot tell whether a container works in %s, so it is left for the next pass: %w", folder, err)
		}
		if len(working) > 0 {
			return 0, fmt.Errorf("a container works in %s, so it is left for the next pass: %s", folder, strings.Join(working, ", "))
		}
	}
	return f.Host.StopIn(folder)
}

// workingIn are the containers that work in the folder, mounted at its path.
func (f FolderProcesses) workingIn(folder string) ([]string, error) {
	listed, err := f.Runtime.run("ps", "--all", "--filter", "volume="+folder, "--format", "{{.Names}} {{.State}}")
	if err != nil {
		return nil, err
	}
	var working []string
	for _, line := range strings.Split(listed, "\n") {
		name, state, _ := strings.Cut(strings.TrimSpace(line), " ")
		if name != "" && !runsNothing[state] {
			working = append(working, name)
		}
	}
	return working, nil
}
