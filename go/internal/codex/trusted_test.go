package codex

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestTrustedFoldersAreTheProjectsWhoseTrustLevelIsTrusted(t *testing.T) {
	home := t.TempDir()
	text := `model = "gpt"
[projects."/a"]
trust_level = "trusted"

[projects.'/b c']
trust_level = 'trusted'  # asked once

[projects."/untrusted"]
trust_level = "untrusted"

[projects."/with \"quote\""]
trust_level = "trusted"

[projects."/after"]
[other]
trust_level = "trusted"
`
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}

	got := TrustedFolders(home)

	want := map[string]bool{"/a": true, "/b c": true, `/with "quote"`: true}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("TrustedFolders(%q) = %v, want %v", home, got, want)
	}
}

func TestNoFolderIsTrustedWhereCodexKeepsNoConfiguration(t *testing.T) {
	if got := TrustedFolders(t.TempDir()); len(got) != 0 {
		t.Errorf("TrustedFolders() = %v, want none", got)
	}
}
