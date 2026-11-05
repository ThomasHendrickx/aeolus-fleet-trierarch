package claudecode

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestTrustedFoldersAreThoseWhoseTrustDialogWasAccepted(t *testing.T) {
	home := t.TempDir()
	text := `{"projects":{"/a":{"hasTrustDialogAccepted":true},"/b":{"hasTrustDialogAccepted":false},"/c":{},"/d":{"hasTrustDialogAccepted":"yes"}}}`
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}

	got := Of(home, "").TrustedFolders()

	if want := map[string]bool{"/a": true}; !reflect.DeepEqual(got, want) {
		t.Errorf("TrustedFolders() = %v, want %v", got, want)
	}
}

func TestNoFolderIsTrustedWhereClaudeCodeKeepsNoFile(t *testing.T) {
	if got := Of(t.TempDir(), "").TrustedFolders(); len(got) != 0 {
		t.Errorf("TrustedFolders() = %v, want none", got)
	}
}
