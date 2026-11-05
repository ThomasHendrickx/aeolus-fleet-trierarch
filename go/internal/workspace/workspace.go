// Package workspace is a session's workspace as git makes it (docs/architecture.md,
// "First adapters"): a worktree of a configured repository, one folder per
// ship, `<root>/<repository>/<ship>`, the repository fetched first and a ref
// the remote has a branch for taken as that remote branch, and none named the
// remote's default branch, so a ship starts from current code. A worktree ends with its session: it is removed whatever
// it holds (worktrees design, items 1 to 3), and what it held is said first.
package workspace

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
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
		return "", fmt.Errorf("git %s failed: %s", actionOf(args), messageOf(string(out)))
	}
	return string(out), nil
}

// actionOf names the git command by its subcommand alone: git's message follows it at once, since a reason is cut at a length and the command's paths would use it up.
func actionOf(args []string) string {
	if len(args) >= 2 && args[0] == "-C" {
		args = args[2:]
	}
	if len(args) >= 2 && args[0] == "worktree" {
		return "worktree " + args[1]
	}
	if len(args) > 0 {
		return args[0]
	}
	return ""
}

// messageOf is what git said, on one line (a reason is one line) and without its hints, which are advice, not the cause.
func messageOf(output string) string {
	lines := []string{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "hint:") {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "; ")
}

// remoteBranch is the remote's branch of that name when the clone has it.
func remoteBranch(path string, name string) (string, bool) {
	if exec.Command("git", "-C", path, "rev-parse", "--verify", "--quiet", "refs/remotes/"+remote+"/"+name).Run() == nil {
		return remote + "/" + name, true
	}
	return "", false
}

// defaultRef is the branch the remote has as its default: what its HEAD names, else the branch the clone's HEAD names (which may be unborn) when the remote has it; empty without one.
func defaultRef(path string) string {
	if out, err := exec.Command("git", "-C", path, "symbolic-ref", "--short", "refs/remotes/"+remote+"/HEAD").Output(); err == nil && strings.TrimSpace(string(out)) != "" {
		return strings.TrimSpace(string(out))
	}
	if out, err := exec.Command("git", "-C", path, "symbolic-ref", "--short", "HEAD").Output(); err == nil {
		if ref, ok := remoteBranch(path, strings.TrimSpace(string(out))); ok {
			return ref
		}
	}
	return ""
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
	ref := defaultRef(at.Path)
	if at.Ref != "" {
		ref = at.Ref
		if branch, ok := remoteBranch(at.Path, ref); ok {
			ref = branch
		}
	}
	if ref != "" {
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

// Places are the configured repositories and folders by name, and the worktree root, as the run pass makes and removes a ship's workspace.
type Places struct {
	Root         string
	Repositories map[string]string
	Folders      map[string]string
	// Clone clones a trusted repository the machine lacks into its path before its first workspace (aeolus-fleet#384); none clones nothing.
	Clone func(repository string, path string) error
	// ClonedPath is the clone of a repository that left the trusted repositories, which still holds the workspaces made from it; none finds none.
	ClonedPath func(repository string) (string, bool)
}

// Prepare is the ship's folder: its worktree, made when missing, or the configured folder as it is.
func (p Places) Prepare(entry reconciler.Entry, shipName string) (string, error) {
	if entry.Workspace.Kind == "folder" {
		folder, ok := p.Folders[entry.Workspace.Name]
		if !ok {
			return "", fmt.Errorf("the configuration has no folder %s", entry.Workspace.Name)
		}
		return folder, nil
	}
	repository, ok := p.Repositories[entry.Workspace.Repository]
	if !ok {
		return "", fmt.Errorf("the configuration has no repository %s", entry.Workspace.Repository)
	}
	if p.Clone != nil {
		if err := p.Clone(entry.Workspace.Repository, repository); err != nil {
			return "", err
		}
	}
	return Prepare(Worktree{Root: p.Root, Repository: entry.Workspace.Repository, Path: repository, ShipName: shipName, Ref: entry.Workspace.Ref})
}

func (p Places) Unsaved(folder string) ([]string, error) {
	return Unsaved(folder)
}

// Remove removes the ship's worktree; a configured folder is never removed.
func (p Places) Remove(entry reconciler.Entry) error {
	if entry.Workspace.Kind != "worktree" || entry.Folder == "" {
		return nil
	}
	repository, ok := p.Repositories[entry.Workspace.Repository]
	if !ok && p.ClonedPath != nil {
		// A clone whose repository left the trusted repositories still holds the worktrees made from it.
		repository, ok = p.ClonedPath(entry.Workspace.Repository)
	}
	if !ok {
		return fmt.Errorf("the configuration has no repository %s to remove %s from", entry.Workspace.Repository, entry.Folder)
	}
	return Remove(repository, entry.Folder)
}
