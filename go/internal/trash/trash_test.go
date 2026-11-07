package trash

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trash/trashtest"
)

var discardedAt = time.Date(2026, 11, 7, 9, 30, 0, 0, time.UTC)

// aFolder is `<root>/aeolus-fleet/scout` with a file in it, as a ship's clone stands, and answers its root and the folder.
func aFolder(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	folder := filepath.Join(root, "aeolus-fleet", "scout")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "README.md"), []byte("scout\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, folder
}

func discarded(t *testing.T, folder string) {
	t.Helper()
	if err := Discard(folder, discardedAt); err != nil {
		t.Fatalf("Discard(%s) = %v, want it moved aside", folder, err)
	}
}

func held(t *testing.T, trash string) []string {
	t.Helper()
	entries, err := os.ReadDir(trash)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func besideTheFolderOf(folder string) Trash {
	return Trash{Beside: func() []string { return []string{filepath.Dir(folder)} }}
}

func TestADiscardedFolderLeavesItsPlaceAtOnceForTheTrashBesideIt(t *testing.T) {
	_, folder := aFolder(t)

	discarded(t, folder)

	if _, err := os.Lstat(folder); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Lstat(%s) = %v, want its place free", folder, err)
	}
	if got := held(t, filepath.Join(filepath.Dir(folder), ".trash")); len(got) != 1 {
		t.Errorf("the trash beside it holds %v, want the folder alone", got)
	}
}

func TestAFolderDiscardedTwiceUnderOneNameIsKeptAsTwo(t *testing.T) {
	_, folder := aFolder(t)
	discarded(t, folder)
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := Discard(folder, discardedAt.Add(time.Millisecond)); err != nil {
		t.Fatalf("Discard(%s) again = %v, want it moved aside", folder, err)
	}

	if got := held(t, filepath.Join(filepath.Dir(folder), ".trash")); len(got) != 2 {
		t.Errorf("the trash holds %v, want both", got)
	}
}

func TestEmptyingTheTrashRemovesWhatItHoldsAFolderMadeReadOnlyIncluded(t *testing.T) {
	_, folder := aFolder(t)
	readOnly := filepath.Join(folder, "a", "b")
	if err := os.MkdirAll(readOnly, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(readOnly, "f"), []byte("f\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(readOnly, 0o500); err != nil {
		t.Fatal(err)
	}
	discarded(t, folder)

	left := besideTheFolderOf(folder).Empty()

	if len(left) != 0 {
		t.Errorf("Empty() left %v, want nothing", left)
	}
	if got := held(t, filepath.Join(filepath.Dir(folder), ".trash")); len(got) != 0 {
		t.Errorf("the trash holds %v, want nothing", got)
	}
}

func TestWhatTheHostCannotRemoveIsRemovedWithinTheRuntimesUserNamespace(t *testing.T) {
	root, folder := aFolder(t)
	trashtest.Unremovable(t, root, folder)
	discarded(t, folder)
	trash := besideTheFolderOf(folder)
	trash.Unshare = trashtest.RemoveAsRuntime

	left := trash.Empty()

	if len(left) != 0 {
		t.Errorf("Empty() left %v, want nothing", left)
	}
	if got := held(t, filepath.Join(filepath.Dir(folder), ".trash")); len(got) != 0 {
		t.Errorf("the trash holds %v, want nothing", got)
	}
}

func TestWhatCannotBeRemovedStaysInTheTrashNewOnlyTheFirstTime(t *testing.T) {
	cases := map[string]func(string) error{
		"on the host":   nil,
		"in containers": func(string) error { return errors.New("unshare refused") },
	}
	for name, unshare := range cases {
		t.Run(name, func(t *testing.T) {
			root, folder := aFolder(t)
			trashtest.Unremovable(t, root, folder)
			discarded(t, folder)
			trash := besideTheFolderOf(folder)
			trash.Unshare = unshare

			first, second := trash.Empty(), trash.Empty()

			if len(first) != 1 || first[0].Folder != folder || !first[0].IsNew || first[0].IsTold || !first[0].TrashedAt.Equal(discardedAt) || first[0].Why == nil {
				t.Fatalf("first Empty() = %+v, want %s left, new, untold, trashed at %v, with why", first, folder, discardedAt)
			}
			if len(second) != 1 || second[0].IsNew || second[0].Path != first[0].Path {
				t.Errorf("second Empty() = %+v, want it left as before, no longer new", second)
			}
			if _, err := os.Lstat(first[0].Path); err != nil {
				t.Errorf("Lstat(%s) = %v, want it still in the trash", first[0].Path, err)
			}
		})
	}
}

func TestWhatWasLeftAndToldStaysToldAndIsTriedAgain(t *testing.T) {
	root, folder := aFolder(t)
	trashtest.Unremovable(t, root, folder)
	discarded(t, folder)
	trash := besideTheFolderOf(folder)
	left := trash.Empty()

	if err := trash.MarkTold(left[0].Path); err != nil {
		t.Fatalf("MarkTold(%s) = %v", left[0].Path, err)
	}
	again := trash.Empty()

	if len(again) != 1 || !again[0].IsTold || again[0].IsNew || !again[0].TrashedAt.Equal(discardedAt) {
		t.Fatalf("Empty() after MarkTold = %+v, want it left, told, not new, trashed at %v", again, discardedAt)
	}
	trash.Unshare = trashtest.RemoveAsRuntime
	if gone := trash.Empty(); len(gone) != 0 {
		t.Errorf("Empty() once it can be removed = %+v, want nothing left", gone)
	}
}

func TestAPlaceWithNoTrashLeavesNothing(t *testing.T) {
	_, folder := aFolder(t)

	if left := besideTheFolderOf(folder).Empty(); len(left) != 0 {
		t.Errorf("Empty() with no trash = %v, want nothing", left)
	}
}
