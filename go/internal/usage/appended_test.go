package usage

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func appendTo(t *testing.T, path string, text string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

func TestAGrowingFileIsReadOnFromWhereTheLastReadEndedEachLineWhole(t *testing.T) {
	path := filepath.Join(t.TempDir(), "transcript.jsonl")
	appendTo(t, path, "one\ntwo\nthr")
	var appended AppendedLines

	first, err := appended.Read(path)
	if err != nil {
		t.Fatal(err)
	}
	appendTo(t, path, "ee\nfour\n")
	second, err := appended.Read(path)
	if err != nil {
		t.Fatal(err)
	}

	if want := (Lines{Lines: []string{"one", "two"}, IsFromStart: true}); !reflect.DeepEqual(first, want) {
		t.Errorf("first read = %+v, want %+v", first, want)
	}
	if want := (Lines{Lines: []string{"three", "four"}}); !reflect.DeepEqual(second, want) {
		t.Errorf("second read = %+v, want %+v", second, want)
	}
}

func TestAFileThatShrankIsReadAgainFromItsStart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "transcript.jsonl")
	appendTo(t, path, "one\ntwo\n")
	var appended AppendedLines
	if _, err := appended.Read(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := appended.Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if want := (Lines{Lines: []string{"new"}, IsFromStart: true}); !reflect.DeepEqual(got, want) {
		t.Fatalf("read = %+v, want %+v", got, want)
	}
}

func TestAFolderWasMadeWhenItWasBornNotWhenItsEntriesLastChanged(t *testing.T) {
	before := time.Now().Add(-time.Second)
	folder := filepath.Join(t.TempDir(), "scout")
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	made, err := FolderMadeAt(folder)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	appendTo(t, filepath.Join(folder, "fake-turns.jsonl"), "a turn\n")

	again, err := FolderMadeAt(folder)
	if err != nil {
		t.Fatal(err)
	}
	if made.Before(before) || made.After(time.Now()) {
		t.Errorf("FolderMadeAt = %v, want a time since %v", made, before)
	}
	if !again.Equal(made) {
		t.Errorf("FolderMadeAt after a file was added = %v, want %v", again, made)
	}
}
