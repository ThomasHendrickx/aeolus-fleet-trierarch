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
