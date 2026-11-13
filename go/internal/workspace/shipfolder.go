package workspace

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trash"
)

// The ship folder (docs/design/ship-folder.md): `<ships>/<shipId>/repositories`, where a ship's session starts, holding its main
// repository in `main/` and each sub-repository in `sub-repos/<repository>/`, side by side, so no repository sits inside another. The
// folder itself is no repository: what a session leaves at its root is never committed. Its root AGENTS.md, with CLAUDE.md a link to
// it so every harness reads the same, is the trierarch's, written again at every start.
const (
	// ShipFolderName is the ship folder in a ship's folder.
	ShipFolderName = "repositories"
	// MainFolder is the main repository in the ship folder.
	MainFolder = "main"
	// SubRepositoriesFolder is the folder of the sub-repositories in the ship folder, one folder each by its name.
	SubRepositoriesFolder = "sub-repos"
	rootInstructions      = "AGENTS.md"
	rootLink              = "CLAUDE.md"
)

// RootInstructions is the root AGENTS.md of a ship folder: where to work from, each sub-repository, and the layout's facts every ship shares.
func RootInstructions(workspace reconciler.Workspace, clashes ...SkillClash) string {
	named := []string{"None: this ship works in its main repository alone."}
	if len(workspace.SubRepositories) > 0 {
		named = named[:0]
		for _, sub := range workspace.SubRepositories {
			named = append(named, fmt.Sprintf("- `%s/%s/`: read its AGENTS.md, or its CLAUDE.md where it has none, before working in it.", SubRepositoriesFolder, sub.Repository))
		}
	}
	lines := []string{
		"# This ship folder",
		"",
		fmt.Sprintf("This folder holds the repositories this ship works in. Work from `%[1]s/`, the main repository: read `%[1]s/AGENTS.md` first, or `%[1]s/CLAUDE.md` where it has none, and follow it.", MainFolder),
		"",
		"## Sub-repositories",
		"",
	}
	lines = append(lines, named...)
	lines = append(lines, "")
	lines = append(lines, clashesText(clashes)...)
	lines = append(lines,
		"## The layout",
		"",
		"- Each repository commits, branches and pushes on its own: run git inside the one you work in.",
		"- This folder holds no repository of its own: nothing outside a repository is committed, so keep your work in one.",
		"- The files and links at this folder's root, this AGENTS.md and CLAUDE.md a link to it, are the trierarch's, written again at every start: change nothing here.",
		"",
	)
	return strings.Join(lines, "\n")
}

// WriteRootFiles writes the ship folder's root AGENTS.md and CLAUDE.md, a link to it, and its skill links again, whatever the session
// left there; nothing for a configured folder.
func WriteRootFiles(folder string, workspace reconciler.Workspace) error {
	if workspace.Kind != "repositories" {
		return nil
	}
	repositories := []string{MainFolder}
	for _, sub := range workspace.SubRepositories {
		repositories = append(repositories, SubRepositoriesFolder+"/"+sub.Repository)
	}
	clashes, err := linkSkills(folder, repositories)
	if err != nil {
		return fmt.Errorf("link the skills of %s: %w", folder, err)
	}
	for _, name := range []string{rootInstructions, rootLink} {
		if err := os.RemoveAll(filepath.Join(folder, name)); err != nil {
			return fmt.Errorf("write the root files of %s: %w", folder, err)
		}
	}
	if err := os.WriteFile(filepath.Join(folder, rootInstructions), []byte(RootInstructions(workspace, clashes...)), 0o644); err != nil {
		return fmt.Errorf("write the root files of %s: %w", folder, err)
	}
	if err := os.Symlink(rootInstructions, filepath.Join(folder, rootLink)); err != nil {
		return fmt.Errorf("write the root files of %s: %w", folder, err)
	}
	return nil
}

// MainMadeError is a sub-repository git cannot make after `main/` was made: it says the repository `main/` is made of now, so the next
// try knows it and never trashes it.
type MainMadeError struct {
	// Repository is the repository `main/` is made of.
	Repository string
	Err        error
}

func (e *MainMadeError) Error() string { return e.Err.Error() }

func (e *MainMadeError) Unwrap() error { return e.Err }

// makeRepository makes a repository's workspace at the folder when it is not there, as the places make one: a worktree, or a clone.
type makeRepository func(repository reconciler.RepositoryAt, folder string) error

// prepareShipFolder makes the ship folder in the ship's folder, or brings the one it has to the workspace: `main/` replaced when it was
// made of another repository, each sub-repository no longer named into the trash beside the ships' folders, then the main repository
// and each sub-repository made where it is not there yet, in the request's order. One git cannot make fails it with git's message, and
// those made stay for the next try: a sub-repository's failure is a MainMadeError. Answers the ship folder.
func prepareShipFolder(shipFolder string, workspace reconciler.Workspace, madeMain string, makeOne makeRepository, withinUserNamespace func(from string, to string) error) (string, error) {
	folder := filepath.Join(shipFolder, ShipFolderName)
	if err := os.MkdirAll(filepath.Join(folder, SubRepositoriesFolder), shipFolderMode); err != nil {
		return "", err
	}
	toTrash := func(path string) error {
		if _, err := os.Lstat(path); errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return trash.DiscardInto(path, filepath.Dir(shipFolder), time.Now(), withinUserNamespace)
	}
	if madeMain != "" && madeMain != workspace.Main.Repository {
		if err := toTrash(filepath.Join(folder, MainFolder)); err != nil {
			return "", err
		}
	}
	found, err := os.ReadDir(filepath.Join(folder, SubRepositoriesFolder))
	if err != nil {
		return "", err
	}
	for _, each := range found {
		named := slices.ContainsFunc(workspace.SubRepositories, func(sub reconciler.RepositoryAt) bool { return sub.Repository == each.Name() })
		if !named {
			if err := toTrash(filepath.Join(folder, SubRepositoriesFolder, each.Name())); err != nil {
				return "", err
			}
		}
	}
	if err := makeOne(workspace.Main, filepath.Join(folder, MainFolder)); err != nil {
		return "", err
	}
	for _, sub := range workspace.SubRepositories {
		if err := makeOne(sub, filepath.Join(folder, SubRepositoriesFolder, sub.Repository)); err != nil {
			return "", &MainMadeError{Repository: workspace.Main.Repository, Err: err}
		}
	}
	return folder, nil
}

// repositoryFoldersIn are the folders of the repositories the ship folder holds now: `main/`, then each sub-repository by its name. Only
// a folder that is not there is none: one that cannot be read fails it, so no repository is left out of what its removal would discard.
func repositoryFoldersIn(folder string) ([]string, error) {
	found := []string{}
	main, err := os.Stat(filepath.Join(folder, MainFolder))
	switch {
	case err == nil && main.IsDir():
		found = append(found, filepath.Join(folder, MainFolder))
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return nil, err
	}
	subs, err := os.ReadDir(filepath.Join(folder, SubRepositoriesFolder))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	for _, each := range subs {
		if each.IsDir() {
			found = append(found, filepath.Join(folder, SubRepositoriesFolder, each.Name()))
		}
	}
	return found, nil
}

// Held is what removing one repository of a ship folder would discard, by its folder.
type Held struct {
	Folder  string
	Unsaved []string
}
