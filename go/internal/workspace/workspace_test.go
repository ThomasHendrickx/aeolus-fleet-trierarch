package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

func gitIn(t *testing.T, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=t@example.com")
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return string(out)
}

// aRepository is a git repository with one commit, and a worktree root beside it.
func aRepository(t *testing.T) (string, string) {
	t.Helper()
	repository := filepath.Join(t.TempDir(), "aeolus-fleet")
	gitIn(t, "init", "-q", "-b", "main", repository)
	if err := os.WriteFile(filepath.Join(repository, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, "-C", repository, "add", ".")
	gitIn(t, "-C", repository, "commit", "-q", "-m", "init")
	return repository, t.TempDir()
}

func TestAWorktreeIsMadeUnderTheRootByRepositoryAndShip(t *testing.T) {
	repository, root := aRepository(t)

	folder, err := Prepare(Worktree{Root: root, Repository: "aeolus-fleet", Path: repository, ShipName: "scout"})

	if err != nil {
		t.Fatal(err)
	}
	if folder != filepath.Join(root, "aeolus-fleet", "scout") {
		t.Fatalf("folder %s", folder)
	}
	if _, err := os.Stat(filepath.Join(folder, "README.md")); err != nil {
		t.Fatalf("the worktree holds no checkout: %v", err)
	}
}

func TestAWorktreeLeftByAStopMidCrewIsUsedAsItIs(t *testing.T) {
	repository, root := aRepository(t)
	at := Worktree{Root: root, Repository: "aeolus-fleet", Path: repository, ShipName: "scout"}
	folder, _ := Prepare(at)
	if err := os.WriteFile(filepath.Join(folder, "notes.md"), []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	again, err := Prepare(at)

	if err != nil || again != folder {
		t.Fatalf("again %s, %v", again, err)
	}
	if _, err := os.Stat(filepath.Join(folder, "notes.md")); err != nil {
		t.Fatalf("the worktree was made again")
	}
}

func TestAWorktreeIsMadeAtTheRefItsRequestNames(t *testing.T) {
	repository, root := aRepository(t)
	gitIn(t, "-C", repository, "branch", "issue-99")
	gitIn(t, "-C", repository, "commit", "-q", "--allow-empty", "-m", "later on main")
	want := strings.TrimSpace(gitIn(t, "-C", repository, "rev-parse", "issue-99"))

	folder, err := Prepare(Worktree{Root: root, Repository: "aeolus-fleet", Path: repository, ShipName: "scout", Ref: "issue-99"})

	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(gitIn(t, "-C", folder, "rev-parse", "HEAD")); got != want {
		t.Fatalf("HEAD %s, want %s", got, want)
	}
}

func TestWhatAWorktreeHoldsUnsavedIsItsChangesAndItsCommitsNoBranchHas(t *testing.T) {
	repository, root := aRepository(t)
	folder, _ := Prepare(Worktree{Root: root, Repository: "aeolus-fleet", Path: repository, ShipName: "scout"})
	if err := os.WriteFile(filepath.Join(folder, "notes.md"), []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, "-C", folder, "commit", "-q", "--allow-empty", "-m", "unpushed work")

	unsaved, err := Unsaved(folder)

	if err != nil {
		t.Fatal(err)
	}
	if len(unsaved) != 2 || !slices.Contains(unsaved, "?? notes.md") || !strings.HasSuffix(unsaved[1], "unpushed work") {
		t.Fatalf("unsaved %q", unsaved)
	}
}

func TestAWorktreeIsRemovedWhateverItHolds(t *testing.T) {
	repository, root := aRepository(t)
	folder, _ := Prepare(Worktree{Root: root, Repository: "aeolus-fleet", Path: repository, ShipName: "scout"})
	if err := os.WriteFile(filepath.Join(folder, "notes.md"), []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := Remove(repository, folder); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(folder); err == nil {
		t.Fatalf("the worktree stayed")
	}
	if strings.Contains(gitIn(t, "-C", repository, "worktree", "list"), folder) {
		t.Fatalf("git still lists it")
	}
}

func TestAShipsWorktreeIsMadeFromItsConfiguredRepository(t *testing.T) {
	repository, root := aRepository(t)
	places := Places{Root: root, Repositories: map[string]string{"aeolus-fleet": repository}, Folders: map[string]string{}}
	entry := reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "aeolus-fleet"}}

	folder, err := places.Prepare(entry, "scout")
	if err != nil || folder != filepath.Join(root, "aeolus-fleet", "scout") {
		t.Fatalf("folder %s, %v", folder, err)
	}
	entry.Folder = folder
	if err := places.Remove(entry); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(folder); err == nil {
		t.Fatalf("the worktree stayed")
	}
}

func TestAConfiguredFolderIsUsedAsItIsAndNeverRemoved(t *testing.T) {
	folder := t.TempDir()
	places := Places{Root: t.TempDir(), Repositories: map[string]string{}, Folders: map[string]string{"notes": folder}}
	entry := reconciler.Entry{Workspace: reconciler.Workspace{Kind: "folder", Name: "notes"}}

	got, err := places.Prepare(entry, "scout")
	if err != nil || got != folder {
		t.Fatalf("folder %s, %v", got, err)
	}
	entry.Folder = got
	if err := places.Remove(entry); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(folder); err != nil {
		t.Fatalf("the configured folder was removed")
	}
}

func TestARepositoryNotConfiguredIsSaid(t *testing.T) {
	places := Places{Root: t.TempDir(), Repositories: map[string]string{}, Folders: map[string]string{}}

	if _, err := places.Prepare(reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "website"}}, "scout"); err == nil {
		t.Fatalf("a worktree of a repository not configured")
	}
}

func TestATrustedRepositoryIsClonedBeforeItsFirstWorktreeIsMade(t *testing.T) {
	source, root := aRepository(t)
	clone := filepath.Join(t.TempDir(), "hemma")
	var cloned []string
	places := Places{Root: root, Repositories: map[string]string{"hemma": clone}, Folders: map[string]string{}, Clone: func(repository string, path string) error {
		cloned = append(cloned, repository+" at "+path)
		gitIn(t, "clone", "-q", source, path)
		return nil
	}}
	entry := reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "hemma"}}

	folder, err := places.Prepare(entry, "scout")

	if err != nil || folder != filepath.Join(root, "hemma", "scout") {
		t.Fatalf("folder %s, %v", folder, err)
	}
	if !slices.Equal(cloned, []string{"hemma at " + clone}) {
		t.Errorf("cloned %v, want hemma at its path", cloned)
	}
}

func TestACloneThatFailsFailsTheWorkspaceWithItsReasonAndMakesNoWorktree(t *testing.T) {
	root := t.TempDir()
	places := Places{Root: root, Repositories: map[string]string{"hemma": filepath.Join(t.TempDir(), "hemma")}, Folders: map[string]string{}, Clone: func(string, string) error {
		return os.ErrPermission
	}}

	_, err := places.Prepare(reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "hemma"}}, "scout")

	if err == nil || err.Error() != os.ErrPermission.Error() {
		t.Errorf("Prepare = %v, want the clone's failure", err)
	}
	if _, err := os.Stat(filepath.Join(root, "hemma", "scout")); err == nil {
		t.Error("a worktree was made though the clone failed")
	}
}

func TestAWorktreeOfARepositoryThatLeftTheListIsRemovedFromItsClone(t *testing.T) {
	clone, root := aRepository(t)
	folder := filepath.Join(root, "hemma", "scout")
	gitIn(t, "-C", clone, "worktree", "add", "--detach", folder)
	places := Places{Root: root, Repositories: map[string]string{}, Folders: map[string]string{}, ClonedPath: func(repository string) (string, bool) {
		return clone, repository == "hemma"
	}}

	err := places.Remove(reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "hemma"}, Folder: folder})

	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(folder); err == nil {
		t.Error("the worktree stayed")
	}
}

func TestInContainersAShipsFolderIsItsRealPathWhichTheContainerMountsAsTheHostKeysIt(t *testing.T) {
	repository, root := aRepository(t)
	linked := filepath.Join(t.TempDir(), "worktrees")
	if err := os.Symlink(root, linked); err != nil {
		t.Fatal(err)
	}
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	entry := reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "aeolus-fleet"}}

	for _, isByRealPath := range []bool{false, true} {
		places := Places{Root: linked, Repositories: map[string]string{"aeolus-fleet": repository}, IsByRealPath: isByRealPath}
		want := filepath.Join(linked, "aeolus-fleet", "scout")
		if isByRealPath {
			want = filepath.Join(real, "aeolus-fleet", "scout")
		}

		if folder, err := places.Prepare(entry, "scout"); err != nil || folder != want {
			t.Errorf("by its real path %v: Prepare = %q, %v; want %q", isByRealPath, folder, err, want)
		}
	}
}

// mkdir makes each folder with its parents.
func mkdir(t *testing.T, folders ...string) {
	t.Helper()
	for _, folder := range folders {
		if err := os.MkdirAll(folder, 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEveryFolderUnderTheRootIsListedWhateverMadeItNeverTheTrashAFileOrALink(t *testing.T) {
	repository, root := aRepository(t)
	notes := t.TempDir()
	scout := filepath.Join(root, "aeolus-fleet", "scout")
	gitIn(t, "-C", repository, "worktree", "add", "-q", "--detach", scout)
	ownClone := filepath.Join(root, "aeolus-fleet", "own-clone")
	gitIn(t, "clone", "-q", repository, ownClone)
	unknown := filepath.Join(root, "hemma", "notes")
	foreign := filepath.Join(root, "aeolus-fleet", "aeolus-fleet-gateway")
	gitIn(t, "-C", anotherRepository(t), "worktree", "add", "-q", "--detach", foreign)
	straight := filepath.Join(root, "aeolus-fleet-designer-release")
	gitIn(t, "clone", "-q", repository, straight)
	mkdir(t, unknown, filepath.Join(root, "aeolus-fleet", ".trash", "scout.1"))
	if err := os.WriteFile(filepath.Join(root, "aeolus-fleet", "notes.md"), []byte("a file\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(notes, filepath.Join(root, "aeolus-fleet", "linked")); err != nil {
		t.Fatal(err)
	}
	places := Places{Root: root, Repositories: map[string]string{"aeolus-fleet": repository}}

	got, err := places.FoldersUnderRoot()

	want := []string{foreign, ownClone, scout, straight, filepath.Join(root, "hemma"), unknown}
	slices.Sort(want)
	if slices.Sort(got); err != nil || !slices.Equal(got, want) {
		t.Fatalf("FoldersUnderRoot() = %v, %v, want %v", got, err, want)
	}
}

func TestAFolderStraightUnderTheRootThatIsNoRepositoryIsListedWithItsFoldersButARepositorysOwnOrOneHoldingTheTrashOnlyByWhatItHolds(t *testing.T) {
	repository, root := aRepository(t)
	notes := t.TempDir()
	scout := filepath.Join(root, "aeolus-fleet", "scout")
	gitIn(t, "-C", repository, "worktree", "add", "-q", "--detach", scout)
	workbench := filepath.Join(root, "workbench")
	lookout := filepath.Join(root, "left-repository", "lookout")
	mkdir(t, filepath.Join(workbench, "tools"), filepath.Join(root, "left-repository", ".trash"), lookout)
	if err := os.Symlink(notes, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	places := Places{Root: root, Repositories: map[string]string{"aeolus-fleet": repository}}

	got, err := places.FoldersUnderRoot()

	want := []string{scout, lookout, workbench, filepath.Join(workbench, "tools")}
	slices.Sort(want)
	if slices.Sort(got); err != nil || !slices.Equal(got, want) {
		t.Fatalf("FoldersUnderRoot() = %v, %v, want %v", got, err, want)
	}
}

func TestAFolderStraightUnderTheRootThatGitDoesNotKnowIsRemoved(t *testing.T) {
	for _, isClone := range []bool{false, true} {
		repository, root := aRepository(t)
		workbench := filepath.Join(root, "workbench")
		mkdir(t, filepath.Join(workbench, "tools"))
		places := Places{Root: root, Repositories: map[string]string{"aeolus-fleet": repository}, IsClone: isClone}

		if err := places.RemoveWorktree(workbench); err != nil {
			t.Fatalf("beside clones %v: RemoveWorktree(%s) = %v", isClone, workbench, err)
		}
		if _, err := os.Lstat(workbench); err == nil {
			t.Errorf("beside clones %v: %s stayed", isClone, workbench)
		}
	}
}

func TestAConfiguredFolderUnderTheRootIsNotListed(t *testing.T) {
	repository, root := aRepository(t)
	notes := filepath.Join(root, "notes", "today")
	mkdir(t, notes)
	places := Places{Root: root, Repositories: map[string]string{"aeolus-fleet": repository}, Folders: map[string]string{"notes": notes}}

	got, err := places.FoldersUnderRoot()

	if err != nil || len(got) != 0 {
		t.Fatalf("FoldersUnderRoot() = %v, %v, want none", got, err)
	}
}

func TestTheFoldersUnderARootReachedThroughALinkAreListedUnderTheRootOrByTheirRealPath(t *testing.T) {
	repository, real := aRepository(t)
	root := filepath.Join(t.TempDir(), "root")
	if err := os.Symlink(real, root); err != nil {
		t.Fatal(err)
	}
	mkdir(t, filepath.Join(real, "aeolus-fleet", "scout"))
	for _, isByRealPath := range []bool{false, true} {
		places := Places{Root: root, Repositories: map[string]string{"aeolus-fleet": repository}, IsByRealPath: isByRealPath}
		want := []string{filepath.Join(root, "aeolus-fleet", "scout")}
		if isByRealPath {
			want = []string{filepath.Join(real, "aeolus-fleet", "scout")}
		}

		if got, err := places.FoldersUnderRoot(); err != nil || !slices.Equal(got, want) {
			t.Errorf("by its real path %v: FoldersUnderRoot() = %v, %v, want %v", isByRealPath, got, err, want)
		}
	}
}

func TestAWorktreeIsRemovedByItsPathFromTheRepositoryItsPathNames(t *testing.T) {
	repository, root := aRepository(t)
	folder := filepath.Join(root, "aeolus-fleet", "stray")
	gitIn(t, "-C", repository, "worktree", "add", "-q", "--detach", folder)
	places := Places{Root: root, Repositories: map[string]string{"aeolus-fleet": repository}}

	if err := places.RemoveWorktree(folder); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(folder); err == nil {
		t.Error("the worktree stayed")
	}
	if listed := gitIn(t, "-C", repository, "worktree", "list"); strings.Contains(listed, "stray") {
		t.Errorf("git still lists it: %s", listed)
	}
}

func TestAPlainCloneAFolderGitDoesNotKnowAndAWorktreeOfAnotherRepositoryUnderTheRootAreRemoved(t *testing.T) {
	repository, root := aRepository(t)
	plain := filepath.Join(root, "aeolus-fleet", "own-clone")
	gitIn(t, "clone", "-q", repository, plain)
	unknown := filepath.Join(root, "hemma", "notes")
	mkdir(t, filepath.Join(unknown, "deep"))
	other := anotherRepository(t)
	foreign := filepath.Join(root, "aeolus-fleet", "aeolus-fleet-gateway")
	gitIn(t, "-C", other, "worktree", "add", "-q", "--detach", foreign)
	straight := filepath.Join(root, "aeolus-fleet-designer-release")
	gitIn(t, "clone", "-q", repository, straight)
	places := Places{Root: root, Repositories: map[string]string{"aeolus-fleet": repository}}

	for _, folder := range []string{plain, unknown, foreign, straight} {
		if err := places.RemoveWorktree(folder); err != nil {
			t.Errorf("RemoveWorktree(%s) = %v", folder, err)
		}
		if _, err := os.Lstat(folder); err == nil {
			t.Errorf("%s stayed", folder)
		}
	}
	if _, err := os.Stat(other); err != nil {
		t.Errorf("the other repository went: %v", err)
	}
}

func TestTheRootItsTrashAFolderDeeperThanAWorkspaceAndOneOutsideTheRootAreNotRemoved(t *testing.T) {
	repository, root := aRepository(t)
	trash := filepath.Join(root, "aeolus-fleet", ".trash")
	deeper := filepath.Join(root, "aeolus-fleet", "scout", "src")
	outside := t.TempDir()
	mkdir(t, trash, deeper)
	places := Places{Root: root, Repositories: map[string]string{"aeolus-fleet": repository}}

	for _, folder := range []string{root, trash, deeper, outside} {
		if err := places.RemoveWorktree(folder); err == nil || !strings.Contains(err.Error(), "removes only a folder under the root") {
			t.Errorf("RemoveWorktree(%s) = %v, want a refusal", folder, err)
		}
		if _, err := os.Stat(folder); err != nil {
			t.Errorf("%s went: %v", folder, err)
		}
	}
}

func TestAPruneDropsTheRecordOfAWorktreeWhoseFolderIsGoneAndLeavesALiveWorktreeOutsideTheRootAlone(t *testing.T) {
	repository, root := aRepository(t)
	elsewhere := t.TempDir()
	gone, live := filepath.Join(elsewhere, "gone"), filepath.Join(elsewhere, "live")
	gitIn(t, "-C", repository, "worktree", "add", "-q", "--detach", gone)
	gitIn(t, "-C", repository, "worktree", "add", "-q", "--detach", live)
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}
	places := Places{Root: root, Repositories: map[string]string{"aeolus-fleet": repository}}

	if err := places.Prune("aeolus-fleet"); err != nil {
		t.Fatal(err)
	}

	listed := gitIn(t, "-C", repository, "worktree", "list", "--porcelain")
	if strings.Contains(listed, "worktree "+gone+"\n") {
		t.Errorf("the record of %s stayed: %s", gone, listed)
	}
	if !strings.Contains(listed, "worktree "+live+"\n") {
		t.Errorf("the record of %s went: %s", live, listed)
	}
	if _, err := os.Stat(live); err != nil {
		t.Errorf("the live worktree went: %v", err)
	}
}

func TestThePruneOfARepositoryTheConfigurationDoesNotHaveFails(t *testing.T) {
	_, root := aRepository(t)
	places := Places{Root: root, Repositories: map[string]string{}}

	err := places.Prune("unknown")

	if err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Errorf("Prune() = %v, want an error naming unknown", err)
	}
}
