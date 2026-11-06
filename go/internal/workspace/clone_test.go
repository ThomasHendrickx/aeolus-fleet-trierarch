package workspace

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// clonePlaces are the places of sessions in containers, each ship in a clone of its own, of the repository and with the folder notes.
func clonePlaces(repository string, root string, notes string) Places {
	return Places{Root: root, Repositories: map[string]string{"aeolus-fleet": repository}, Folders: map[string]string{"notes": notes}, IsClone: true}
}

var scoutInAeolusFleet = reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "aeolus-fleet"}}

// withUpstream gives the repository an upstream as its origin, fetched, and answers its path.
func withUpstream(t *testing.T, repository string) string {
	t.Helper()
	upstream := filepath.Join(t.TempDir(), "upstream")
	gitIn(t, "clone", "-q", "--bare", repository, upstream)
	gitIn(t, "-C", repository, "remote", "add", "origin", upstream)
	gitIn(t, "-C", repository, "fetch", "-q", "origin")
	return upstream
}

func commitIn(t *testing.T, folder string, file string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(folder, file), []byte(file+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, "-C", folder, "add", ".")
	gitIn(t, "-C", folder, "commit", "-q", "-m", file)
}

func prepared(t *testing.T, places Places, entry reconciler.Entry, shipName string) string {
	t.Helper()
	folder, err := places.Prepare(entry, shipName)
	if err != nil {
		t.Fatal(err)
	}
	return folder
}

func revision(t *testing.T, folder string, ref string) string {
	t.Helper()
	return strings.TrimSpace(gitIn(t, "-C", folder, "rev-parse", ref))
}

func TestACloneIsMadeUnderTheRootOneFolderPerShipDetachedAtHead(t *testing.T) {
	repository, root := aRepository(t)

	folder := prepared(t, clonePlaces(repository, root, t.TempDir()), scoutInAeolusFleet, "scout")

	if want := filepath.Join(root, "aeolus-fleet", "scout"); folder != want {
		t.Errorf("Prepare = %s, want %s", folder, want)
	}
	if got := strings.TrimSpace(gitIn(t, "-C", folder, "rev-parse", "--abbrev-ref", "HEAD")); got != "HEAD" {
		t.Errorf("HEAD is %s, want detached", got)
	}
	if got, want := revision(t, folder, "HEAD"), revision(t, repository, "HEAD"); got != want {
		t.Errorf("HEAD = %s, want the repository's %s", got, want)
	}
}

func TestACloneHoldsItsOwnObjectsSoItWorksWithTheRepositorysGone(t *testing.T) {
	repository, root := aRepository(t)
	folder := prepared(t, clonePlaces(repository, root, t.TempDir()), scoutInAeolusFleet, "scout")

	if err := os.RemoveAll(repository); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(folder, ".git", "objects", "info", "alternates")); err == nil {
		t.Error("the clone borrows the repository's objects")
	}
	gitIn(t, "-C", folder, "fsck", "--no-progress")
	if got := strings.TrimSpace(gitIn(t, "-C", folder, "log", "--format=%s")); got != "init" {
		t.Errorf("log = %q, want init", got)
	}
}

func TestACloneHasAGitFolderOfItsOwnThatGitInTheRepositoryNeverLists(t *testing.T) {
	repository, root := aRepository(t)

	folder := prepared(t, clonePlaces(repository, root, t.TempDir()), scoutInAeolusFleet, "scout")

	if info, err := os.Stat(filepath.Join(folder, ".git")); err != nil || !info.IsDir() {
		t.Errorf(".git is no folder of its own: %v", err)
	}
	if got := gitIn(t, "-C", repository, "worktree", "list", "--porcelain"); strings.Contains(got, folder) {
		t.Errorf("the repository lists the clone as a worktree: %s", got)
	}
}

func TestACloneHasTheRepositorysOwnRemoteAsItsOriginWithItsRemoteBranches(t *testing.T) {
	repository, root := aRepository(t)
	upstream := withUpstream(t, repository)

	folder := prepared(t, clonePlaces(repository, root, t.TempDir()), scoutInAeolusFleet, "scout")

	if got := strings.TrimSpace(gitIn(t, "-C", folder, "remote")); got != "origin" {
		t.Errorf("remotes %q, want origin alone", got)
	}
	if got := strings.TrimSpace(gitIn(t, "-C", folder, "remote", "get-url", "origin")); got != upstream {
		t.Errorf("origin %s, want %s", got, upstream)
	}
	if got, want := revision(t, folder, "refs/remotes/origin/main"), revision(t, repository, "refs/remotes/origin/main"); got != want {
		t.Errorf("origin/main = %s, want %s", got, want)
	}
}

func TestACloneHasNoRemoteWhenTheRepositoryHasNone(t *testing.T) {
	repository, root := aRepository(t)

	folder := prepared(t, clonePlaces(repository, root, t.TempDir()), scoutInAeolusFleet, "scout")

	if got := strings.TrimSpace(gitIn(t, "-C", folder, "remote")); got != "" {
		t.Errorf("remotes %q, want none", got)
	}
}

func TestACloneIsMadeAtTheRefItsRequestNames(t *testing.T) {
	repository, root := aRepository(t)
	gitIn(t, "-C", repository, "tag", "v1")
	commitIn(t, repository, "later.md")
	entry := reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "aeolus-fleet", Ref: "v1"}}

	folder := prepared(t, clonePlaces(repository, root, t.TempDir()), entry, "scout")

	if _, err := os.Stat(filepath.Join(folder, "later.md")); err == nil {
		t.Error("the clone is past v1")
	}
}

func TestACloneIsMadeFromTheRemoteBranchForARefFetchedFirst(t *testing.T) {
	repository, root := aRepository(t)
	upstream := withUpstream(t, repository)
	current := filepath.Join(t.TempDir(), "current")
	gitIn(t, "clone", "-q", upstream, current)
	commitIn(t, current, "current.md")
	gitIn(t, "-C", current, "push", "-q", "origin", "main")
	entry := reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "aeolus-fleet", Ref: "main"}}

	folder := prepared(t, clonePlaces(repository, root, t.TempDir()), entry, "scout")

	if got, want := revision(t, folder, "HEAD"), revision(t, current, "HEAD"); got != want {
		t.Errorf("HEAD = %s, want the remote's %s", got, want)
	}
}

func TestACloneIsMadeFromWhatTheRepositoryHasWhenItsRemoteCannotBeFetched(t *testing.T) {
	repository, root := aRepository(t)
	gitIn(t, "-C", repository, "remote", "add", "origin", filepath.Join(t.TempDir(), "gone"))
	entry := reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "aeolus-fleet", Ref: "main"}}

	folder := prepared(t, clonePlaces(repository, root, t.TempDir()), entry, "scout")

	if _, err := os.Stat(filepath.Join(folder, "README.md")); err != nil {
		t.Errorf("the clone holds no checkout: %v", err)
	}
}

func TestACloneLeftByAStopMidCrewIsUsedAsItIs(t *testing.T) {
	repository, root := aRepository(t)
	places := clonePlaces(repository, root, t.TempDir())
	folder := prepared(t, places, scoutInAeolusFleet, "scout")
	if err := os.WriteFile(filepath.Join(folder, "notes.md"), []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if again := prepared(t, places, scoutInAeolusFleet, "scout"); again != folder {
		t.Errorf("Prepare again = %s, want %s", again, folder)
	}
	if _, err := os.Stat(filepath.Join(folder, "notes.md")); err != nil {
		t.Error("the clone was made again")
	}
}

func TestWhatACloneHoldsUnsavedIsItsChangesAndItsCommitsNoBranchTagOrRemoteBranchKeeps(t *testing.T) {
	repository, root := aRepository(t)
	withUpstream(t, repository)
	places := clonePlaces(repository, root, t.TempDir())
	folder := prepared(t, places, reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "aeolus-fleet", Ref: "main"}}, "scout")
	if unsaved, err := places.Unsaved(folder); err != nil || len(unsaved) != 0 {
		t.Fatalf("a fresh clone holds unsaved %v, %v", unsaved, err)
	}
	commitIn(t, folder, "pushed.md")
	gitIn(t, "-C", folder, "push", "-q", "origin", "HEAD:refs/heads/pushed")
	commitIn(t, folder, "done.md")
	if err := os.WriteFile(filepath.Join(folder, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "draft.md"), []byte("draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	unsaved, err := places.Unsaved(folder)

	done := strings.TrimSpace(gitIn(t, "-C", folder, "rev-parse", "--short", "HEAD"))
	if want := []string{" M README.md", "?? draft.md", "commit " + done + " done.md"}; err != nil || !slices.Equal(unsaved, want) {
		t.Errorf("Unsaved = %q, %v, want %q", unsaved, err, want)
	}
}

func TestAShipsCloneIsRemovedWithItsEntry(t *testing.T) {
	repository, root := aRepository(t)
	places := clonePlaces(repository, root, t.TempDir())
	entry := scoutInAeolusFleet
	entry.Folder = prepared(t, places, entry, "scout")

	if err := places.Remove(entry); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(entry.Folder); err == nil {
		t.Error("the clone stayed")
	}
}

func TestACloneIsRemovedByItsPath(t *testing.T) {
	repository, root := aRepository(t)
	places := clonePlaces(repository, root, t.TempDir())
	folder := prepared(t, places, scoutInAeolusFleet, "scout")

	if err := places.RemoveWorktree(folder); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(folder); err == nil {
		t.Error("the clone stayed")
	}
}

func TestNothingOutsideTheRootIsRemovedAsAClone(t *testing.T) {
	repository, root := aRepository(t)
	notes := t.TempDir()
	places := clonePlaces(repository, root, notes)

	err := places.RemoveWorktree(notes)

	if err == nil || !strings.Contains(err.Error(), "removes only what it made") {
		t.Errorf("RemoveWorktree(%s) = %v, want a refusal", notes, err)
	}
	if _, err := os.Stat(notes); err != nil {
		t.Errorf("the folder went: %v", err)
	}
}

func TestAConfiguredFolderIsUsedAsItIsBesideClones(t *testing.T) {
	repository, root := aRepository(t)
	notes := t.TempDir()

	folder := prepared(t, clonePlaces(repository, root, notes), reconciler.Entry{Workspace: reconciler.Workspace{Kind: "folder", Name: "notes"}}, "scout")

	if folder != notes {
		t.Errorf("Prepare = %s, want %s", folder, notes)
	}
}

func TestTheClonesUnderTheRootAreListedByRepositoryAndNameAndNothingElseThere(t *testing.T) {
	repository, root := aRepository(t)
	places := clonePlaces(repository, root, t.TempDir())
	prepared(t, places, scoutInAeolusFleet, "scout")
	prepared(t, places, scoutInAeolusFleet, "lookout")
	gitIn(t, "clone", "-q", repository, filepath.Join(root, "aeolus-fleet-designer-release"))
	for _, folder := range []string{filepath.Join(root, "aeolus-fleet", ".git"), filepath.Join(root, "aeolus-fleet", "src")} {
		if err := os.MkdirAll(folder, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "aeolus-fleet", "README.md"), []byte("a plain clone"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := places.Worktrees()

	want := []reconciler.Worktree{
		{Path: filepath.Join(root, "aeolus-fleet", "lookout"), Repository: "aeolus-fleet", Name: "lookout"},
		{Path: filepath.Join(root, "aeolus-fleet", "scout"), Repository: "aeolus-fleet", Name: "scout"},
	}
	if err != nil || !slices.Equal(got, want) {
		t.Errorf("Worktrees() = %v, %v, want %v", got, err, want)
	}
}

func TestATrustedRepositoryIsClonedBeforeTheShipsOwnClone(t *testing.T) {
	source, root := aRepository(t)
	clone := filepath.Join(t.TempDir(), "hemma")
	places := Places{Root: root, Repositories: map[string]string{"hemma": clone}, IsClone: true, Clone: func(_ string, path string) error {
		gitIn(t, "clone", "-q", source, path)
		return nil
	}}

	folder := prepared(t, places, reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "hemma"}}, "scout")

	if got, want := revision(t, folder, "HEAD"), revision(t, source, "HEAD"); folder != filepath.Join(root, "hemma", "scout") || got != want {
		t.Errorf("Prepare = %s at %s, want %s at %s", folder, got, filepath.Join(root, "hemma", "scout"), want)
	}
}

func TestTheCloneOfAShipWhoseRepositoryLeftTheListIsRemoved(t *testing.T) {
	source, root := aRepository(t)
	folder := prepared(t, clonePlaces(source, root, t.TempDir()), scoutInAeolusFleet, "scout")
	places := Places{Root: root, Repositories: map[string]string{}, IsClone: true, ClonedPath: func(repository string) (string, bool) {
		return source, repository == "aeolus-fleet"
	}}

	if err := places.Remove(reconciler.Entry{Workspace: scoutInAeolusFleet.Workspace, Folder: folder}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(folder); err == nil {
		t.Error("the clone stayed")
	}
}

func TestRecognizesACloneItMadeAfterRestartButRefusesAnUnmarkedClone(t *testing.T) {
	repository, root := aRepository(t)
	notes := t.TempDir()
	folder := prepared(t, clonePlaces(repository, root, notes), scoutInAeolusFleet, "scout")
	stray := filepath.Join(root, "aeolus-fleet", "stray")
	gitIn(t, "clone", "-q", repository, stray)
	places := clonePlaces(repository, root, notes)
	for _, test := range []struct {
		name   string
		folder string
		want   bool
	}{
		{"made clone", folder, true}, {"unmarked clone", stray, false}, {"outside root", repository, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := places.IsMade(test.folder); got != test.want {
				t.Errorf("IsMade(%s) = %v, want %v", test.folder, got, test.want)
			}
		})
	}
}

func TestACloneIsCheckedOutThroughTheFiltersTheMachinesOwnConfigDefines(t *testing.T) {
	repository, root := aRepository(t)
	writeIn(t, repository, ".gitattributes", "*.txt filter=upper\n")
	writeIn(t, repository, "hello.txt", "hello\n")
	gitIn(t, "-C", repository, "add", ".")
	gitIn(t, "-C", repository, "commit", "-q", "-m", "hello.txt")
	gitIn(t, "config", "--file", aThrowawayHome(t), "filter.upper.smudge", "tr a-z A-Z")

	folder := prepared(t, clonePlaces(repository, root, t.TempDir()), scoutInAeolusFleet, "scout")

	if got, err := os.ReadFile(filepath.Join(folder, "hello.txt")); err != nil || string(got) != "HELLO\n" {
		t.Errorf("hello.txt in the clone = %q, %v, want %q, through the machine's filter", got, err, "HELLO\n")
	}
}
