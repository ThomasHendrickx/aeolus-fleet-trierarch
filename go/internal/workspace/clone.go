package workspace

import (
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

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trash"
)

// A clone is the workspace of a session in a container (decision 0039; docs/trierarch.md, "Session runtime"): a per-ship clone of the
// configured repository in place of a worktree, at the same path (`<root>/<repository>/<ship>`). A worktree points into the
// repository's `.git`, its hooks and every other ship's worktree data; a clone has a `.git` of its own. `--reference` with
// `--dissociate` borrows the repository's objects only while cloning, so the clone holds its own and no gc of the repository can
// break it. Its origin is the repository's own remote, so the session pushes without the host, with the remote branches as the
// repository last fetched them; a repository with no remote leaves the clone with none. What it holds unsaved is a worktree's.

// A clone the trierarch made holds its marker in its `.git`, where git keeps no record of it: an orphan clone is cleared only with it.
// These two are the marker's one place.
const cloneMarker, cloneMarkerContent = "aeolus-trierarch-clone", "1\n"

// markMade writes the marker in a clone the trierarch just made.
func markMade(folder string) error {
	return os.WriteFile(filepath.Join(folder, ".git", cloneMarker), []byte(cloneMarkerContent), 0o644)
}

// isMarkedMade is whether the clone holds the marker the trierarch writes in each clone it makes.
func isMarkedMade(folder string) bool {
	marker, err := os.ReadFile(filepath.Join(folder, ".git", cloneMarker))
	return err == nil && string(marker) == cloneMarkerContent
}

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
	folder := filepath.Join(at.Root, at.Repository, at.ShipName)
	if _, err := os.Stat(folder); err == nil {
		return folder, nil
	}
	if err := os.MkdirAll(filepath.Dir(folder), 0o755); err != nil {
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
	// Marked before anything else, so a stop mid-crew leaves an orphan the trierarch knows as its own.
	if err := markMade(folder); err != nil {
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

// removeClone removes a clone under the root, `<root>/<repository>/<ship>` of a repository it has; anything else it never removes.
func (p Places) removeClone(folder string) error {
	relative, err := filepath.Rel(p.Root, folder)
	parts := strings.Split(relative, string(filepath.Separator))
	if err != nil || len(parts) != 2 || parts[1] == "" || parts[0] == ".." || parts[1] == ".." {
		return fmt.Errorf("%s is no clone under %s: the trierarch removes only what it made", folder, p.Root)
	}
	if _, ok := p.repositoryOf(folder); !ok {
		return fmt.Errorf("%s is no clone under %s: the trierarch removes only what it made", folder, p.Root)
	}
	// One already gone is removed already.
	if _, err := os.Lstat(folder); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	// Aside at once, so its ship's place is free and nothing reads it again; the trash removes it (docs/trierarch.md, "Session runtime").
	if err := trash.Discard(folder, time.Now(), p.MoveWithinUserNamespace); err != nil {
		return fmt.Errorf("remove clone %s: %w", folder, err)
	}
	return nil
}

// clones are the clones under the root of the configured repositories: each folder `<root>/<repository>/<name>` with a `.git` of
// its own. A file or folder without one is part of something else, such as a plain clone.
func (p Places) clones() []reconciler.Worktree {
	found := []reconciler.Worktree{}
	for _, repository := range slices.Sorted(maps.Keys(p.Repositories)) {
		entries, err := os.ReadDir(filepath.Join(p.Root, repository))
		if err != nil {
			continue
		}
		for _, entry := range entries {
			path := filepath.Join(p.Root, repository, entry.Name())
			if _, err := os.Stat(filepath.Join(path, ".git")); err != nil {
				continue
			}
			found = append(found, reconciler.Worktree{Path: path, Repository: repository, Name: entry.Name()})
		}
	}
	return found
}
