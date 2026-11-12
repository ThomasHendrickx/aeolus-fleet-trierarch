package workspace

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trash"
)

// A clone is the workspace of a session in a container (decision 0039; docs/trierarch.md, "Session runtime"): a per-ship clone of the
// configured repository in place of a worktree, at the same path (`<ships>/<shipId>/worktree`, or for a ship crewed before the ship
// folders `<root>/<repository>/<ship>`). A worktree points into the
// repository's `.git`, its hooks and every other ship's worktree data; a clone has a `.git` of its own. `--reference` with
// `--dissociate` borrows the repository's objects only while cloning, so the clone holds its own and no gc of the repository can
// break it. Its origin is the repository's own remote, so the session pushes without the host, with the remote branches as the
// repository last fetched them; a repository with no remote leaves the clone with none. What it holds unsaved is a worktree's.

// resolve is the commit of the remote branch for the ref when the remote has one, else of the ref as it is, or of HEAD with none.
func resolve(repository string, ref string) (string, error) {
	if ref == "" {
		out, err := git("-C", repository, "rev-parse", "--verify", "HEAD^{commit}")
		return strings.TrimSpace(out), err
	}
	if out, err := exec.Command("git", "-C", repository, "rev-parse", "--verify", "--quiet", "refs/remotes/"+remote+"/"+ref+"^{commit}").Output(); err == nil {
		return strings.TrimSpace(string(out)), nil
	}
	out, err := git("-C", repository, "rev-parse", "--verify", ref+"^{commit}")
	return strings.TrimSpace(out), err
}

// PrepareClone makes the ship's clone, or takes the one a stop mid-crew left, and answers its folder.
func PrepareClone(at Worktree) (prepared string, err error) {
	folder := at.folder()
	if _, err := os.Stat(folder); err == nil {
		return folder, nil
	}
	if err := makeParentOf(at); err != nil {
		return "", err
	}
	// A repository with no remote, or one that cannot be reached now, is cloned from as it is.
	_ = exec.Command("git", "-C", at.Path, "fetch", "--quiet", remote).Run()
	commit, err := resolve(at.Path, at.Ref)
	if err != nil {
		return "", err
	}
	defer func() {
		if err != nil {
			if cleanupErr := os.RemoveAll(folder); cleanupErr != nil {
				err = errors.Join(err, fmt.Errorf("remove failed clone %s: %w", folder, cleanupErr))
			}
		}
	}()
	if _, err := git("clone", "--quiet", "--no-checkout", "--reference", at.Path, "--dissociate", at.Path, folder); err != nil {
		return "", err
	}
	// The clone's origin is the repository's checkout, whose branches are no remote's: dropped with it.
	if _, err := gitInFreshClone(folder, "remote", "remove", remote); err != nil {
		return "", err
	}
	if url, err := exec.Command("git", "-C", at.Path, "remote", "get-url", remote).Output(); err == nil {
		if _, err := gitInFreshClone(folder, "remote", "add", remote, strings.TrimSpace(string(url))); err != nil {
			return "", err
		}
		if _, err := gitInFreshClone(folder, "fetch", "--quiet", "--no-tags", at.Path, "+refs/remotes/"+remote+"/*:refs/remotes/"+remote+"/*"); err != nil {
			return "", err
		}
	}
	if _, err := gitInFreshClone(folder, "checkout", "--quiet", "--detach", commit); err != nil {
		return "", err
	}
	return folder, nil
}

// removeClone removes a folder under the root beside clones: aside into the trash beside it, which a pass empties, as a session in a
// container may leave in it what the host cannot remove; a ship's folder too, straight under the place of the ships' folders. One
// straight under the worktree root of the ships crewed before has no trash beside it a pass empties, and no session ran in it, so the
// host removes it.
func (p Places) removeClone(folder string) error {
	parent := filepath.Dir(folder)
	if p.Before != "" && p.Before != p.Root {
		if real, err := filepath.EvalSymlinks(p.Before); parent == p.Before || (err == nil && parent == real) {
			return os.RemoveAll(folder)
		}
	}
	// Aside at once, so its ship's place is free and nothing reads it again; the trash removes it (docs/trierarch.md, "Session runtime").
	if err := trash.Discard(folder, time.Now(), p.MoveWithinUserNamespace); err != nil {
		return fmt.Errorf("remove clone %s: %w", folder, err)
	}
	return nil
}
