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
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
	return said(exec.Command("git", args...), args)
}

// gitInFolder is git run in a ship's folder, which ignores the folder's own config where it names a program.
func gitInFolder(folder string, args ...string) (string, error) {
	command, err := inFolder(folder, args...)
	if err != nil {
		return "", err
	}
	return said(command, args)
}

// gitInClone is git run in a ship's clone, which ignores the clone's own config where it names a program, through the clone's own `.git`.
func gitInClone(clone string, args ...string) (string, error) {
	command, err := inClone(clone, args...)
	if err != nil {
		return "", err
	}
	return said(command, args)
}

// said is what the git command said, or why it failed.
func said(command *exec.Cmd, args []string) (string, error) {
	out, err := command.CombinedOutput()
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
	return unsavedIn(folder, gitInFolder)
}

// refusedPrefix starts what a folder the host does not read holds, as unsaved: not known, so it is told with why, never taken for clean.
const refusedPrefix = "refused, "

// unsavedIn is what the folder holds that no remote, branch or tag has, as git in it says; a folder the host does not read is one line, why.
func unsavedIn(folder string, gitIn func(folder string, args ...string) (string, error)) ([]string, error) {
	changes, err := gitIn(folder, "status", "--porcelain", "--ignore-submodules=all")
	if refused := (*RefusedError)(nil); errors.As(err, &refused) {
		return []string{refusedPrefix + refused.Reason}, nil
	}
	if err != nil {
		return nil, err
	}
	commits, err := gitIn(folder, "log", "--format=commit %h %s", "HEAD", "--not", "--branches", "--tags", "--remotes")
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
	// IsByRealPath gives each folder by its real path, as sessions in containers need it: the container mounts the folder at the path it is given, where the plugin inside keys it by `pwd -P` as the host's does (decision 0039).
	IsByRealPath bool
	// IsClone gives each ship a clone of its own in place of a worktree, at the same path, as sessions in containers need it: git works inside, and no ship's container reaches another's (decision 0039).
	IsClone bool
}

// Prepare is the ship's folder: its worktree, made when missing, or the configured folder as it is; by its real path when the places say so.
func (p Places) Prepare(entry reconciler.Entry, shipName string) (string, error) {
	folder, err := p.prepare(entry, shipName)
	if err != nil || !p.IsByRealPath {
		return folder, err
	}
	return filepath.EvalSymlinks(folder)
}

func (p Places) prepare(entry reconciler.Entry, shipName string) (string, error) {
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
	at := Worktree{Root: p.Root, Repository: entry.Workspace.Repository, Path: repository, ShipName: shipName, Ref: entry.Workspace.Ref}
	if p.IsClone {
		return PrepareClone(at)
	}
	return Prepare(at)
}

// Unsaved is what the ship's worktree, or its clone, holds that no remote, branch or tag has.
func (p Places) Unsaved(folder string) ([]string, error) {
	if p.IsClone {
		return unsavedIn(folder, gitInClone)
	}
	return Unsaved(folder)
}

// Remove removes the ship's worktree, or its clone; a configured folder is never removed.
func (p Places) Remove(entry reconciler.Entry) error {
	if entry.Workspace.Kind != "worktree" || entry.Folder == "" {
		return nil
	}
	if p.IsClone {
		return p.removeClone(entry.Folder)
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

// repositoryOf is the repository a folder under the root is a worktree of, by the name its path starts with: a configured one, or the clone of one that left the trusted repositories, which still holds the worktrees made from it.
func (p Places) repositoryOf(folder string) (string, bool) {
	relative, err := filepath.Rel(p.Root, folder)
	if err != nil {
		return "", false
	}
	name := strings.Split(relative, string(filepath.Separator))[0]
	if repository, ok := p.Repositories[name]; ok {
		return repository, true
	}
	if p.ClonedPath != nil {
		return p.ClonedPath(name)
	}
	return "", false
}

// listed are the paths of the repository's worktrees as git lists them, by their real paths.
func listed(repository string) ([]string, error) {
	out, err := git("-C", repository, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	paths := []string{}
	for _, line := range strings.Split(out, "\n") {
		if path, ok := strings.CutPrefix(line, "worktree "); ok {
			paths = append(paths, path)
		}
	}
	return paths, nil
}

// Worktrees are the worktrees of the configured repositories under the root, `<root>/<repository>/<name>`, or their clones; a repository git cannot list has none.
func (p Places) Worktrees() ([]reconciler.Worktree, error) {
	if p.IsClone {
		return p.clones(), nil
	}
	// Git lists each worktree by its real path, so a root reached through a link is matched by its own.
	realRoot, err := filepath.EvalSymlinks(p.Root)
	if err != nil {
		realRoot = p.Root
	}
	found := []reconciler.Worktree{}
	for _, name := range slices.Sorted(maps.Keys(p.Repositories)) {
		paths, err := listed(p.Repositories[name])
		if err != nil {
			continue
		}
		for _, path := range paths {
			relative, err := filepath.Rel(realRoot, path)
			if err != nil {
				continue
			}
			parts := strings.Split(relative, string(filepath.Separator))
			if len(parts) == 2 && parts[0] == name {
				found = append(found, reconciler.Worktree{Path: filepath.Join(p.Root, name, parts[1]), Repository: name, Name: parts[1]})
			}
		}
	}
	return found, nil
}

// IsMade is whether the folder is a workspace the trierarch made: one `<root>/<repository>/<ship>` of a repository it has, a worktree
// git knows or a clone holding its marker. Anything else under its root is not its to clear.
func (p Places) IsMade(folder string) bool {
	relative, err := filepath.Rel(p.Root, folder)
	if err != nil || len(strings.Split(relative, string(filepath.Separator))) != 2 {
		return false
	}
	repository, ok := p.repositoryOf(folder)
	if !ok {
		return false
	}
	if p.IsClone {
		return isMarkedMade(folder)
	}
	paths, err := listed(repository)
	if err != nil {
		return false
	}
	real, err := filepath.EvalSymlinks(folder)
	if err != nil {
		real = folder
	}
	return slices.Contains(paths, folder) || slices.Contains(paths, real)
}

// RemoveWorktree removes a worktree or a clone under the root by its path, from the repository its path names; a folder of no repository it has is never removed.
func (p Places) RemoveWorktree(folder string) error {
	if p.IsClone {
		return p.removeClone(folder)
	}
	repository, ok := p.repositoryOf(folder)
	if !ok {
		return fmt.Errorf("%s is no worktree under %s: the trierarch removes only what it made", folder, p.Root)
	}
	return Remove(repository, folder)
}
