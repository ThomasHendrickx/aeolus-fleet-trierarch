// Package workspace is a session's workspace as git makes it (docs/architecture.md,
// "First adapters"): a worktree of a configured repository in the ship's own
// folder, `<ships>/<shipId>/worktree`, or for a ship crewed before the ship
// folders `<root>/<repository>/<ship>`, the repository fetched first and a ref
// the remote has a branch for taken as that remote branch, and none named the
// remote's default branch, so a ship starts from current code. A worktree ends with its session: it is removed whatever
// it holds (worktrees design, items 1 to 3), and what it held is said first. A local branch checked out in no worktree whose remote branch is
// gone is deleted (item 5).
package workspace

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trash"
)

const remote = "origin"

// Worktree is where a ship's worktree is made: in its folder, or with none under the root by the ship's name, of the configured
// repository at its path, at a ref when one is named.
type Worktree struct {
	Root       string
	Repository string
	Path       string
	ShipName   string
	Ref        string
	// Folder is where the worktree is made, in the ship's folder; none makes it at `<root>/<repository>/<ship>`, as for a ship crewed
	// before the ship folders.
	Folder string
}

// folder is where the worktree is made.
func (at Worktree) folder() string {
	if at.Folder != "" {
		return at.Folder
	}
	return filepath.Join(at.Root, at.Repository, at.ShipName)
}

// shipFolderMode is a ship's folder's mode: only its owner opens it.
const shipFolderMode = 0o700

func git(args ...string) (string, error) {
	return said(exec.Command("git", args...), args)
}

// gitInFolder is git run in a ship's folder, which ignores the folder's own config where it names a program, within its time limit.
func gitInFolder(folder string, args ...string) (string, error) {
	as := reading{limit: timeLimit}
	ctx, cancel := context.WithTimeout(context.Background(), as.limit)
	defer cancel()
	command, err := inFolder(ctx, folder, as, args...)
	if err != nil {
		return "", err
	}
	return saidWithin(ctx, as.limit, folder, command, args)
}

// gitInClone is git run in a ship's clone, which ignores the clone's own config where it names a program, through the clone's own
// `.git`, within its time limit.
func gitInClone(clone string, args ...string) (string, error) {
	return gitInCloneAs(clone, reading{isClone: true, limit: timeLimit}, args)
}

// gitInFreshClone is git run in a clone the trierarch just made from a trusted repository, before any session touched it, as in any
// clone, but through the filters the machine's own config defines, so its checkout is what a session works on (git-lfs's files, not
// their pointers).
func gitInFreshClone(clone string, args ...string) (string, error) {
	return gitInCloneAs(clone, reading{isClone: true, isFresh: true, limit: freshTimeLimit}, args)
}

// gitInCloneAs is git run in a ship's clone, read as it says.
func gitInCloneAs(clone string, as reading, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), as.limit)
	defer cancel()
	command, err := inClone(ctx, clone, as, args...)
	if err != nil {
		return "", err
	}
	return saidWithin(ctx, as.limit, clone, command, args)
}

// saidWithin is what the git command in the folder said, or why it failed: a refusal of the folder when it ran past its time limit.
func saidWithin(ctx context.Context, limit time.Duration, folder string, command *exec.Cmd, args []string) (string, error) {
	out, err := said(command, args)
	if refused := endedAt(ctx, limit, folder, actionOf(args)); err != nil && refused != nil {
		return "", refused
	}
	return out, err
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
	folder := at.folder()
	if _, err := os.Stat(folder); err == nil {
		return folder, nil
	}
	if err := makeParentOf(at); err != nil {
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
	commits, err := gitIn(folder, "log", "--no-show-signature", "--format=commit %h %s", "HEAD", "--not", "--branches", "--tags", "--remotes")
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

// makeParentOf makes the folder the worktree is made in: the ship's folder for its owner alone, or the repository's under the root.
func makeParentOf(at Worktree) error {
	if at.Folder != "" {
		return os.MkdirAll(filepath.Dir(at.Folder), shipFolderMode)
	}
	return os.MkdirAll(filepath.Dir(at.folder()), 0o755)
}

// Places are the configured repositories and folders by name, the place of every ship's folder, and the worktree root of the ships
// crewed before the ship folders, as the run pass makes and removes a ship's workspace.
type Places struct {
	// Root is the place of the ships' folders, `ships/<shipId>/` by default; a configured place of ships/ holds the worktrees of the ships
	// crewed before the ship folders too.
	Root string
	// Before is the worktree root of the ships crewed before the ship folders, where their worktrees stay until they are crewed fresh,
	// when it is not the Root; none when it is.
	Before       string
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
	// MoveWithinUserNamespace moves a clone whose own top the host user cannot give its write to the trash within the runtime's user
	// namespace; nil on the host.
	MoveWithinUserNamespace func(from string, to string) error
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
	at := Worktree{Root: p.before(), Repository: entry.Workspace.Repository, Path: repository, ShipName: shipName, Ref: entry.Workspace.Ref}
	if entry.ShipFolder != "" {
		at.Folder = filepath.Join(entry.ShipFolder, paths.WorktreeFolder)
	}
	if p.IsClone {
		return PrepareClone(at)
	}
	return Prepare(at)
}

// Unsaved is what the ship's worktree, or its clone, holds that no remote, branch or tag has. What a clone holds is not known when
// any read of it fails: told with why, as one the host does not read, so its release tells argo and removes it.
func (p Places) Unsaved(folder string) ([]string, error) {
	if !p.IsClone {
		return Unsaved(folder)
	}
	unsaved, err := unsavedIn(folder, gitInClone)
	if err != nil {
		return []string{refusedPrefix + err.Error()}, nil
	}
	return unsaved, nil
}

// before is the worktree root of the ships crewed before the ship folders.
func (p Places) before() string {
	if p.Before != "" {
		return p.Before
	}
	return p.Root
}

// roots are the places a workspace could be under: the place of the ships' folders, and the worktree root of the ships crewed before.
func (p Places) roots() []string {
	if p.Before == "" || p.Before == p.Root {
		return []string{p.Root}
	}
	return []string{p.Root, p.Before}
}

// ShipFolderOf is the folder a ship crewed fresh keeps every file of its own in, under the place of the ships' folders; by its real
// path when the places say so, as its workspace is.
func (p Places) ShipFolderOf(shipID string) string {
	root := p.Root
	if p.IsByRealPath {
		if real, err := filepath.EvalSymlinks(root); err == nil {
			root = real
		}
	}
	return filepath.Join(root, shipID)
}

// HasShipFolder is whether the ship's folder is there, as a folder; one removed by hand is not.
func (p Places) HasShipFolder(folder string) bool {
	found, err := os.Stat(folder)
	return err == nil && found.IsDir()
}

// Remove removes the ship's worktree, or its clone: a ship's folder goes whole into the trash beside it, whatever it holds, and a
// worktree of a ship crewed before the ship folders goes as git removes it. A configured folder is never removed.
func (p Places) Remove(entry reconciler.Entry) error {
	if entry.ShipFolder != "" {
		return p.removeShipFolder(entry.ShipFolder)
	}
	if entry.Workspace.Kind != "worktree" || entry.Folder == "" {
		return nil
	}
	if p.IsClone {
		return p.RemoveWorktree(entry.Folder)
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

// removeShipFolder moves the ship's folder into the trash beside it, at once, so nothing reads it again; one already gone is removed
// already. Its worktree's record in its repository goes with the next prune.
func (p Places) removeShipFolder(folder string) error {
	if _, err := os.Lstat(folder); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err := trash.Discard(folder, time.Now(), p.MoveWithinUserNamespace); err != nil {
		return fmt.Errorf("remove the ship's folder %s: %w", folder, err)
	}
	return nil
}

// repositoryOf is the repository a folder under a root is a worktree of, by the name its path starts with: a configured one, or the clone of one that left the trusted repositories, which still holds the worktrees made from it.
func (p Places) repositoryOf(folder string) (string, bool) {
	relative := ""
	for _, root := range p.roots() {
		if inRoot, err := filepath.Rel(root, folder); err == nil && filepath.IsLocal(inRoot) {
			relative = inRoot
			break
		}
	}
	if relative == "" {
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

// FoldersUnderRoot are every folder under the root a workspace could be (gap rule 2), whatever made it: each
// `<root>/<repository>/<name>`, and each folder straight under the root, one with a `.git` of its own as one folder, none of its files.
// Never the trash, a file, a link, so nothing a link points at is removed, or a configured folder or one that holds it. By their
// real paths when the places say so, as their workspaces are.
func (p Places) FoldersUnderRoot() ([]string, error) {
	found := []string{}
	tops := []string{}
	for _, root := range p.roots() {
		tops = append(tops, foldersIn(root)...)
	}
	for _, top := range tops {
		if _, err := os.Lstat(filepath.Join(top, ".git")); err == nil {
			found = append(found, top)
			continue
		}
		// A repository's own folder, by its name, or one holding the trash is the layout's: only what it holds is listed. Any other is
		// listed with each folder in it, so the one a ship is crewed in keeps it and what else it holds goes.
		_, isRepository := p.repositoryOf(top)
		if _, err := os.Lstat(filepath.Join(top, trash.FolderName)); err != nil && !isRepository {
			found = append(found, top)
		}
		found = append(found, foldersIn(top)...)
	}
	configured := slices.Collect(maps.Values(p.Folders))
	listed := []string{}
	for _, folder := range found {
		// A configured folder, one that holds it, or one in it, is never a stray.
		if slices.ContainsFunc(configured, func(each string) bool {
			return each == folder || strings.HasPrefix(each, folder+string(filepath.Separator)) || strings.HasPrefix(folder, each+string(filepath.Separator))
		}) {
			continue
		}
		if p.IsByRealPath {
			if real, err := filepath.EvalSymlinks(folder); err == nil {
				folder = real
			}
		}
		listed = append(listed, folder)
	}
	return listed, nil
}

// foldersIn are the folders in the parent, never the trash or a link; none when it cannot be read.
func foldersIn(parent string) []string {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return nil
	}
	folders := []string{}
	for _, entry := range entries {
		if entry.IsDir() && entry.Name() != trash.FolderName {
			folders = append(folders, filepath.Join(parent, entry.Name()))
		}
	}
	return folders
}

// isUnderRoot is whether the folder is one a workspace could be under the root: one or two levels below it, never the root or the
// trash. A root reached through a link counts by its real path too, as a container's workspace goes by its real one.
func (p Places) isUnderRoot(folder string) bool {
	roots := []string{}
	for _, root := range p.roots() {
		roots = append(roots, root)
		if real, err := filepath.EvalSymlinks(root); err == nil {
			roots = append(roots, real)
		}
	}
	return slices.ContainsFunc(roots, func(root string) bool {
		relative, err := filepath.Rel(root, folder)
		if err != nil {
			return false
		}
		parts := strings.Split(relative, string(filepath.Separator))
		return len(parts) <= 2 && !slices.ContainsFunc(parts, func(part string) bool { return part == "" || part == "." || part == ".." || part == trash.FolderName })
	})
}

// isWorktreeOf is whether git lists the folder as a worktree of the repository; it lists real paths, so a root reached over a link is
// compared by its real path too.
func isWorktreeOf(repository string, folder string) bool {
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

// RemoveWorktree removes a folder under the root, whatever it is (gap rule 2): a worktree of a repository it has by git, a clone into
// the trash beside it, anything else, such as a plain clone, a worktree of another repository or a folder git does not know, as it is.
// Never one outside the root, the root or its trash.
func (p Places) RemoveWorktree(folder string) error {
	if !p.isUnderRoot(folder) {
		return fmt.Errorf("%s is not under %s, or is its trash: the trierarch removes only a folder under the root", folder, strings.Join(p.roots(), " or "))
	}
	found, err := os.Lstat(folder)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !found.IsDir() {
		return fmt.Errorf("%s is no folder: the trierarch removes only a folder under the root", folder)
	}
	if p.IsClone {
		return p.removeClone(folder)
	}
	if repository, ok := p.repositoryOf(folder); ok && isWorktreeOf(repository, folder) {
		return Remove(repository, folder)
	}
	return os.RemoveAll(folder)
}

// Prune drops the git records of the repository's worktrees whose folder is gone, wherever the folder was; a worktree whose folder exists
// stays, outside the root too. A repository the places do not have fails.
func (p Places) Prune(repository string) error {
	path, ok := p.Repositories[repository]
	if !ok {
		return fmt.Errorf("the configuration has no repository %s", repository)
	}
	_, err := git("-C", path, "worktree", "prune")
	return err
}

// remoteReadLimit is how long reading a remote's branches may take before the pass goes on without deleting a branch.
const remoteReadLimit = time.Minute

// trackingBranch is a local branch checked out in no worktree, and the remote branch it tracks.
type trackingBranch struct {
	branch, remote, remoteRef string
}

// DeleteBranchesWhoseRemoteBranchIsGone deletes the repository's local branches checked out in no worktree whose remote branch is gone
// from the remote. A branch whose remote branch exists, or that never had one, stays. Every remote is read before anything is deleted,
// so a remote that cannot be read fails and takes no branch for gone. A repository the places do not have fails.
func (p Places) DeleteBranchesWhoseRemoteBranchIsGone(repository string) error {
	path, ok := p.Repositories[repository]
	if !ok {
		return fmt.Errorf("the configuration has no repository %s", repository)
	}
	listed, err := git("-C", path, "for-each-ref", "--format=%(refname)%00%(worktreepath)%00%(upstream:remotename)%00%(upstream:remoteref)", "refs/heads")
	if err != nil {
		return err
	}
	var tracking []trackingBranch
	for _, line := range strings.Split(listed, "\n") {
		fields := strings.Split(line, "\x00")
		if len(fields) != 4 {
			continue
		}
		ref, worktree, remote, remoteRef := fields[0], fields[1], fields[2], fields[3]
		// A branch with no remote branch, or one a worktree has checked out, stays.
		if !strings.HasPrefix(ref, "refs/heads/") || worktree != "" || remote == "" || remote == "." || remoteRef == "" {
			continue
		}
		tracking = append(tracking, trackingBranch{branch: strings.TrimPrefix(ref, "refs/heads/"), remote: remote, remoteRef: remoteRef})
	}
	remoteRefs := map[string]map[string]bool{}
	for _, found := range tracking {
		if _, read := remoteRefs[found.remote]; read {
			continue
		}
		heads, err := remoteBranches(path, found.remote)
		if err != nil {
			return err
		}
		remoteRefs[found.remote] = heads
	}
	for _, found := range tracking {
		if !remoteRefs[found.remote][found.remoteRef] {
			if _, err := git("-C", path, "branch", "-D", found.branch); err != nil {
				return err
			}
		}
	}
	return nil
}

// remoteBranches are the refs of the branches the remote has, read within remoteReadLimit and never asking for credentials.
func remoteBranches(repository, remote string) (map[string]bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), remoteReadLimit)
	defer cancel()
	args := []string{"-C", repository, "ls-remote", "--heads", remote}
	command := exec.CommandContext(ctx, "git", args...)
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := said(command, args)
	if err != nil {
		return nil, err
	}
	heads := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		if _, ref, ok := strings.Cut(line, "\t"); ok {
			heads[ref] = true
		}
	}
	return heads, nil
}
