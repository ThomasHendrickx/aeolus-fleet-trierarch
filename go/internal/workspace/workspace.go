// Package workspace is a session's workspace as git makes it (docs/architecture.md,
// "First adapters"): a worktree of a configured repository, one folder per
// ship, `<root>/<repository>/<ship>`, the repository fetched first and a ref
// the remote has a branch for taken as that remote branch, so a ship starts
// from current code. A worktree ends with its session: it is removed whatever
// it holds (worktrees design, items 1 to 3), and what it held is said first.
package workspace

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const remote = "origin"

// Worktree is where a ship's worktree is made: under the root, of the configured repository at its path, by the ship's name, at a ref when one is named.
type Worktree struct {
	Root       string
	Repository string
	Path       string
	ShipName   string
	Ref        string
}

func git(args ...string) (string, error) {
	out, err := exec.Command("git", args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s failed: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// Prepare makes the ship's worktree, or takes the one a stop mid-crew left, and answers its folder.
func Prepare(at Worktree) (string, error) {
	folder := filepath.Join(at.Root, at.Repository, at.ShipName)
	if _, err := os.Stat(folder); err == nil {
		return folder, nil
	}
	if err := os.MkdirAll(filepath.Dir(folder), 0o755); err != nil {
		return "", err
	}
	// A repository with no remote, or one that cannot be reached now, is made from as it is.
	_ = exec.Command("git", "-C", at.Path, "fetch", "--quiet", remote).Run()
	args := []string{"-C", at.Path, "worktree", "add", "--detach", folder}
	if at.Ref != "" {
		ref := at.Ref
		if exec.Command("git", "-C", at.Path, "rev-parse", "--verify", "--quiet", "refs/remotes/"+remote+"/"+ref).Run() == nil {
			ref = remote + "/" + ref
		}
		args = append(args, ref)
	}
	if _, err := git(args...); err != nil {
		return "", err
	}
	return folder, nil
}

// Unsaved is what the worktree holds that no remote, branch or tag has: its changes, then its commits.
func Unsaved(folder string) ([]string, error) {
	changes, err := git("-C", folder, "status", "--porcelain")
	if err != nil {
		return nil, err
	}
	commits, err := git("-C", folder, "log", "--format=commit %h %s", "HEAD", "--not", "--branches", "--tags", "--remotes")
	if err != nil {
		return nil, err
	}
	unsaved := []string{}
	for _, line := range strings.Split(changes+commits, "\n") {
		if strings.TrimSpace(line) != "" {
			unsaved = append(unsaved, strings.TrimRight(line, " "))
		}
	}
	return unsaved, nil
}

// Remove removes the worktree whatever it holds; one already gone is removed already.
func Remove(repository string, folder string) error {
	if _, err := os.Stat(folder); errors.Is(err, os.ErrNotExist) {
		_, _ = git("-C", repository, "worktree", "prune")
		return nil
	}
	_, err := git("-C", repository, "worktree", "remove", "--force", folder)
	return err
}
