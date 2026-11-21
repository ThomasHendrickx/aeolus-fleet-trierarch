package seen

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestASnapshotReplacesTheWholeFilePrivately(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trierarch", "seen.json")
	file := File{Path: path}
	first := Snapshot{PassAt: "2026-11-20T13:02:27Z", Ships: map[string]Ship{"gone": {Inbox: Inbox{Waiting: 4}}}}
	if err := file.Save(first); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	want := Snapshot{PassAt: "2026-11-20T13:02:57Z", Ships: map[string]Ship{"one": {
		Inbox: Inbox{Waiting: 2, Forced: 1, SeenAt: "2026-11-20T13:02:53Z"},
		Turn:  Turn{State: "busy", Since: "2026-11-20T12:31:27Z", SeenAt: "2026-11-20T13:02:51Z"},
	}}}
	if err := file.Save(want); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got Snapshot
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot = %+v, want %+v", got, want)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
}

func TestAFailedSnapshotWriteLeavesTheLastWholeFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "seen.json")
	file := File{Path: path}
	if err := file.Save(Snapshot{PassAt: "2026-11-20T13:02:27Z", Ships: map[string]Ship{}}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path+".tmp", 0700); err != nil {
		t.Fatal(err)
	}
	if err := file.Save(Snapshot{PassAt: "2026-11-20T13:02:57Z"}); err == nil {
		t.Fatal("Save succeeded with an unwritable temporary path")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatalf("failed save changed %s to %s", before, after)
	}
}
