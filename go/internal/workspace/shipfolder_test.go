package workspace

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// aNamedRepository is a repository of one commit, named as its folder, holding `<name>.md`: its path.
func aNamedRepository(t *testing.T, name string) string {
	t.Helper()
	repository := filepath.Join(t.TempDir(), name)
	gitIn(t, "init", "-q", "-b", "main", repository)
	writeIn(t, repository, name+".md", name+"\n")
	gitIn(t, "-C", repository, "add", ".")
	gitIn(t, "-C", repository, "commit", "-q", "-m", "init")
	return repository
}

// shipFolderPlaces are places offering aeolus-fleet, tools and skills, each a repository of its own, under a place of ships/ of their own.
func shipFolderPlaces(t *testing.T) (Places, map[string]string) {
	t.Helper()
	repositories := map[string]string{}
	for _, name := range []string{"aeolus-fleet", "tools", "skills"} {
		repositories[name] = aNamedRepository(t, name)
	}
	return Places{Root: t.TempDir(), Repositories: repositories}, repositories
}

// aShipFolderOf is an entry crewed fresh in a ship folder of the main repository and the sub-repositories given.
func aShipFolderOf(places Places, main string, subRepositories ...string) reconciler.Entry {
	workspace := reconciler.Workspace{Kind: "repositories", Main: reconciler.RepositoryAt{Repository: main}}
	for _, sub := range subRepositories {
		workspace.SubRepositories = append(workspace.SubRepositories, reconciler.RepositoryAt{Repository: sub})
	}
	return reconciler.Entry{ShipID: "shp_scout", ShipFolder: places.ShipFolderOf("shp_scout"), Workspace: workspace}
}

// commonGitFolderOf is the git folder of the repository a worktree is of.
func commonGitFolderOf(t *testing.T, worktree string) string {
	t.Helper()
	return strings.TrimSpace(gitIn(t, "-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"))
}

func TestAShipFolderHoldsItsMainRepositoryAndEachSubRepositoryEachAWorktreeOfItsRepository(t *testing.T) {
	places, repositories := shipFolderPlaces(t)

	folder, err := places.Prepare(aShipFolderOf(places, "aeolus-fleet", "tools", "skills"), "scout")
	if err != nil {
		t.Fatal(err)
	}

	for in, repository := range map[string]string{MainFolder: "aeolus-fleet", filepath.Join(SubRepositoriesFolder, "tools"): "tools", filepath.Join(SubRepositoriesFolder, "skills"): "skills"} {
		if got, want := commonGitFolderOf(t, filepath.Join(folder, in)), filepath.Join(repositories[repository], ".git"); got != want {
			t.Errorf("%s is a worktree of %s, want %s", in, got, want)
		}
	}
	if _, err := os.Stat(filepath.Join(folder, ".git")); err == nil {
		t.Error("the ship folder is a repository of its own")
	}
}

func TestANewSettingsVersionKeepsMakesAndTrashesTheSubRepositoriesItNames(t *testing.T) {
	places, _ := shipFolderPlaces(t)
	folder, err := places.Prepare(aShipFolderOf(places, "aeolus-fleet", "tools"), "scout")
	if err != nil {
		t.Fatal(err)
	}
	writeIn(t, filepath.Join(folder, MainFolder), "kept.txt", "kept\n")
	again := aShipFolderOf(places, "aeolus-fleet", "skills")
	again.MadeMain = "aeolus-fleet"

	if _, err := places.Prepare(again, "scout"); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(folder, MainFolder, "kept.txt")); err != nil {
		t.Errorf("main/ was not kept as it is: %v", err)
	}
	if found, err := os.ReadDir(filepath.Join(folder, SubRepositoriesFolder)); err != nil || len(found) != 1 || found[0].Name() != "skills" {
		t.Errorf("sub-repos/ holds %v (%v), want skills alone", found, err)
	}
	if trashed, err := os.ReadDir(filepath.Join(places.Root, ".trash")); err != nil || len(trashed) != 1 || !strings.HasPrefix(trashed[0].Name(), "tools.") {
		t.Errorf("the trash beside the ships' folders holds %v (%v), want tools", trashed, err)
	}
}

func TestANewSettingsVersionNamingAnotherMainRepositoryReplacesMain(t *testing.T) {
	places, repositories := shipFolderPlaces(t)
	folder, err := places.Prepare(aShipFolderOf(places, "aeolus-fleet"), "scout")
	if err != nil {
		t.Fatal(err)
	}
	again := aShipFolderOf(places, "tools")
	again.MadeMain = "aeolus-fleet"

	if _, err := places.Prepare(again, "scout"); err != nil {
		t.Fatal(err)
	}

	if got, want := commonGitFolderOf(t, filepath.Join(folder, MainFolder)), filepath.Join(repositories["tools"], ".git"); got != want {
		t.Errorf("main/ is a worktree of %s, want %s", got, want)
	}
}

func TestARepositoryGitCannotMakeFailsWithGitsMessageKeepingThoseMade(t *testing.T) {
	places, repositories := shipFolderPlaces(t)
	gitIn(t, "-C", repositories["tools"], "update-ref", "-d", "refs/heads/main")

	_, err := places.Prepare(aShipFolderOf(places, "aeolus-fleet", "tools"), "scout")

	if err == nil || !strings.Contains(err.Error(), "git worktree add failed: fatal: invalid reference: HEAD") {
		t.Errorf("Prepare = %v, want git's message", err)
	}
	if _, err := os.Stat(filepath.Join(places.ShipFolderOf("shp_scout"), ShipFolderName, MainFolder, "aeolus-fleet.md")); err != nil {
		t.Errorf("the main repository made went: %v", err)
	}
}

func TestANewMainMadeBeforeASubRepositoryGitCannotMakeIsSaidWithGitsMessageSoTheNextTryKeepsIt(t *testing.T) {
	places, repositories := shipFolderPlaces(t)
	if _, err := places.Prepare(aShipFolderOf(places, "aeolus-fleet"), "scout"); err != nil {
		t.Fatal(err)
	}
	gitIn(t, "-C", repositories["skills"], "update-ref", "-d", "refs/heads/main")
	again := aShipFolderOf(places, "tools", "skills")
	again.MadeMain = "aeolus-fleet"

	_, err := places.Prepare(again, "scout")

	var made *MainMadeError
	if !errors.As(err, &made) || made.Repository != "tools" || !strings.Contains(err.Error(), "git worktree add failed") {
		t.Errorf("Prepare = %v, want git's message, saying main/ is made of tools", err)
	}
}

func TestWhatAShipFolderHoldsUnsavedFailsWhenAFolderInItCannotBeReadRatherThanLeavingARepositoryOut(t *testing.T) {
	places, _ := shipFolderPlaces(t)
	folder, err := places.Prepare(aShipFolderOf(places, "aeolus-fleet", "tools"), "scout")
	if err != nil {
		t.Fatal(err)
	}
	unreadable := filepath.Join(folder, SubRepositoriesFolder)
	if err := os.Chmod(unreadable, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(unreadable, 0o700) })

	held, err := places.UnsavedInShipFolder(folder)

	if !errors.Is(err, fs.ErrPermission) {
		t.Errorf("UnsavedInShipFolder = %v, %v, want it refused", held, err)
	}
}

func TestNothingIsHeldInAShipFolderThatIsGone(t *testing.T) {
	places, _ := shipFolderPlaces(t)

	held, err := places.UnsavedInShipFolder(filepath.Join(places.ShipFolderOf("shp_scout"), ShipFolderName))

	if err != nil || len(held) != 0 {
		t.Errorf("UnsavedInShipFolder = %v, %v, want nothing", held, err)
	}
}

func TestWhatEachRepositoryOfAShipFolderHoldsUnsavedIsSaidByItsFolder(t *testing.T) {
	places, _ := shipFolderPlaces(t)
	folder, err := places.Prepare(aShipFolderOf(places, "aeolus-fleet", "tools"), "scout")
	if err != nil {
		t.Fatal(err)
	}
	writeIn(t, filepath.Join(folder, SubRepositoriesFolder, "tools"), "draft.md", "draft\n")
	writeIn(t, folder, "notes.md", "at the root, in no repository\n")

	held, err := places.UnsavedInShipFolder(folder)

	want := []Held{{Folder: filepath.Join(folder, MainFolder), Unsaved: []string{}}, {Folder: filepath.Join(folder, SubRepositoriesFolder, "tools"), Unsaved: []string{"?? draft.md"}}}
	if err != nil || len(held) != len(want) || !slices.EqualFunc(held, want, func(a, b Held) bool { return a.Folder == b.Folder && slices.Equal(a.Unsaved, b.Unsaved) }) {
		t.Errorf("UnsavedInShipFolder = %v, %v, want %v", held, err, want)
	}
}

func TestInContainersEachSubRepositoryIsACloneOfItsOwn(t *testing.T) {
	places, _ := shipFolderPlaces(t)
	places.IsClone = true

	folder, err := places.Prepare(aShipFolderOf(places, "aeolus-fleet", "tools"), "scout")
	if err != nil {
		t.Fatal(err)
	}

	for _, in := range []string{MainFolder, filepath.Join(SubRepositoriesFolder, "tools")} {
		if found, err := os.Stat(filepath.Join(folder, in, ".git")); err != nil || !found.IsDir() {
			t.Errorf("%s has no .git of its own: %v", in, err)
		}
	}
}

func TestTheRootFilesAreAnAgentsMdNamingEachSubRepositoryAndTheLayoutAndAClaudeMdLinkToIt(t *testing.T) {
	places, _ := shipFolderPlaces(t)
	entry := aShipFolderOf(places, "aeolus-fleet", "tools")
	folder, err := places.Prepare(entry, "scout")
	if err != nil {
		t.Fatal(err)
	}
	entry.Folder = folder

	if err := places.WriteRootFiles(entry); err != nil {
		t.Fatal(err)
	}

	want := strings.Join([]string{
		"# This ship folder",
		"",
		"This folder holds the repositories this ship works in. Work from `main/`, the main repository: read `main/AGENTS.md` first, or `main/CLAUDE.md` where it has none, and follow it.",
		"",
		"## Sub-repositories",
		"",
		"- `sub-repos/tools/`: read its AGENTS.md, or its CLAUDE.md where it has none, before working in it.",
		"",
		"## The layout",
		"",
		"- Each repository commits, branches and pushes on its own: run git inside the one you work in.",
		"- This folder holds no repository of its own: nothing outside a repository is committed, so keep your work in one.",
		"- The files and links at this folder's root, this AGENTS.md and CLAUDE.md a link to it, are the trierarch's, written again at every start: change nothing here.",
		"",
	}, "\n")
	if got, err := os.ReadFile(filepath.Join(folder, "AGENTS.md")); err != nil || string(got) != want {
		t.Errorf("AGENTS.md = %q, %v, want %q", got, err, want)
	}
	if target, err := os.Readlink(filepath.Join(folder, "CLAUDE.md")); err != nil || target != "AGENTS.md" {
		t.Errorf("CLAUDE.md links to %q, %v, want AGENTS.md", target, err)
	}
}

func TestTheRootFilesSayWhenTheShipHasNoSubRepository(t *testing.T) {
	got := RootInstructions(reconciler.Workspace{Kind: "repositories", Main: reconciler.RepositoryAt{Repository: "aeolus-fleet"}})

	if want := "## Sub-repositories\n\nNone: this ship works in its main repository alone.\n"; !strings.Contains(got, want) {
		t.Errorf("RootInstructions = %q, want it to hold %q", got, want)
	}
}

func TestTheRootFilesAreWrittenAgainOverWhatTheSessionLeft(t *testing.T) {
	places, _ := shipFolderPlaces(t)
	entry := aShipFolderOf(places, "aeolus-fleet")
	folder, err := places.Prepare(entry, "scout")
	if err != nil {
		t.Fatal(err)
	}
	entry.Folder = folder
	mkdir(t, filepath.Join(folder, "AGENTS.md"))
	writeIn(t, folder, "CLAUDE.md", "changed by the session\n")

	if err := places.WriteRootFiles(entry); err != nil {
		t.Fatal(err)
	}

	if found, err := os.Stat(filepath.Join(folder, "AGENTS.md")); err != nil || !found.Mode().IsRegular() {
		t.Errorf("AGENTS.md is no file: %v", err)
	}
	if target, err := os.Readlink(filepath.Join(folder, "CLAUDE.md")); err != nil || target != "AGENTS.md" {
		t.Errorf("CLAUDE.md links to %q, %v, want AGENTS.md", target, err)
	}
}

func TestAConfiguredFolderGetsNoRootFiles(t *testing.T) {
	notes := t.TempDir()

	if err := WriteRootFiles(notes, reconciler.Workspace{Kind: "folder", Name: "notes"}); err != nil {
		t.Fatal(err)
	}

	if found, err := os.ReadDir(notes); err != nil || len(found) != 0 {
		t.Errorf("the configured folder holds %v (%v), want nothing", found, err)
	}
}
