// Package checkouts is a ship's read-only checkouts in git (docs/trierarch.md,
// "Read-only checkouts"): per ship, `<root>/<ship id>/<repository>`, a clone of
// the configured repository (`--reference` with `--dissociate`, so it holds
// its own objects) detached at the latest main. The configured repository is
// fetched first, so main is its remote's when it has one, else its own. The
// clone keeps no remote, so the session has none to push to, and no write
// bit, so it changes and commits nothing; a refresh gives the write bits back
// only while it moves the checkout on.
package checkouts

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

const (
	remote = "origin"
	main   = "main"
	// fetched is where a checkout keeps the main it was last brought to.
	fetched = "refs/remotes/" + remote + "/" + main
)

// Checkout is a repository's checkout of a ship, at its path.
type Checkout struct {
	Repository string
	Path       string
}

// Refreshed is what a refresh of one checkout came to: the revision it now holds, or one line on why it could not be moved on and holds what it held.
type Refreshed struct {
	Repository string `json:"repository"`
	Revision   string `json:"revision,omitempty"`
	Problem    string `json:"problem,omitempty"`
}

// Git makes, refreshes and removes the checkouts under Root, of the configured repositories.
type Git struct {
	Root         string
	Repositories map[string]config.Repository
}

func run(program string, args ...string) (string, error) {
	out, err := exec.Command(program, args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s %s failed: %s", program, strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

func (g Git) pathOf(repository string) (string, error) {
	configured, ok := g.Repositories[repository]
	if !ok {
		return "", fmt.Errorf("the configuration has no repository %s", repository)
	}
	return configured.Path, nil
}

// latestMain is the latest main of the repository: its remote's once fetched, when it has one, else its own.
func latestMain(repository string) string {
	// A fetch that fails (offline, no remote) leaves what the repository has.
	_ = exec.Command("git", "-C", repository, "fetch", "--quiet", remote).Run()
	if exec.Command("git", "-C", repository, "rev-parse", "--verify", "--quiet", "refs/remotes/"+remote+"/"+main).Run() == nil {
		return "refs/remotes/" + remote + "/" + main
	}
	return "refs/heads/" + main
}

// bringToMain moves the checkout to the latest main of its repository, writable only meanwhile, and answers the revision it holds.
func (g Git) bringToMain(repository string, path string) (revision string, err error) {
	source, err := g.pathOf(repository)
	if err != nil {
		return "", err
	}
	latest := latestMain(source)
	if _, err := run("chmod", "-R", "u+w", path); err != nil {
		return "", err
	}
	defer func() {
		if _, lockErr := run("chmod", "-R", "a-w", path); err == nil {
			err = lockErr
		}
	}()
	if _, err := run("git", "-C", path, "fetch", "--quiet", "--no-tags", source, "+"+latest+":"+fetched); err != nil {
		return "", err
	}
	if _, err := run("git", "-C", path, "checkout", "--quiet", "--force", "--detach", fetched); err != nil {
		return "", err
	}
	return run("git", "-C", path, "rev-parse", "HEAD")
}

// Prepare makes the ship's checkout of each repository the working repository names, and answers them in the order it names them. One the ship has already stays as it is: only a refresh moves it on.
func (g Git) Prepare(shipID string, repository string) ([]Checkout, error) {
	made := []Checkout{}
	for _, name := range g.Repositories[repository].Checkouts {
		path := filepath.Join(g.Root, shipID, name)
		if _, err := os.Stat(path); err != nil {
			source, err := g.pathOf(name)
			if err != nil {
				return nil, err
			}
			if err := os.MkdirAll(filepath.Join(g.Root, shipID), 0o755); err != nil {
				return nil, err
			}
			if _, err := run("git", "clone", "--quiet", "--no-checkout", "--reference", source, "--dissociate", source, path); err != nil {
				return nil, err
			}
			if _, err := run("git", "-C", path, "remote", "remove", remote); err != nil {
				return nil, err
			}
			if _, err := g.bringToMain(name, path); err != nil {
				return nil, err
			}
		}
		made = append(made, Checkout{Repository: name, Path: path})
	}
	return made, nil
}

// Refresh brings each of the ship's checkouts to the latest main, in order of name; one that cannot be moved on says why and holds what it held, and the others are refreshed.
func (g Git) Refresh(shipID string) []Refreshed {
	refreshed := []Refreshed{}
	entries, _ := os.ReadDir(filepath.Join(g.Root, shipID))
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		revision, err := g.bringToMain(name, filepath.Join(g.Root, shipID, name))
		if err != nil {
			refreshed = append(refreshed, Refreshed{Repository: name, Problem: strings.SplitN(err.Error(), "\n", 2)[0]})
			continue
		}
		refreshed = append(refreshed, Refreshed{Repository: name, Revision: revision})
	}
	return refreshed
}

// Remove removes the ship's checkouts, read-only as they are; none is nothing.
func (g Git) Remove(shipID string) error {
	path := filepath.Join(g.Root, shipID)
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	if _, err := run("chmod", "-R", "u+w", path); err != nil {
		return err
	}
	return os.RemoveAll(path)
}
