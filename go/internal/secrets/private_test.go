package secrets

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

// privateWriters are the files that hold what only the trierarch's user may read: the sealing key, by its own call, and the MCP configuration, through WritePrivate.
var privateWriters = []struct {
	label string
	name  string
	write func(path string) error
}{
	{"the sealing key", "sealing-key", func(path string) error {
		_, err := LoadOrMake(path)
		return err
	}},
	{"the MCP configuration", "mcp-configuration.json", func(path string) error {
		return WritePrivate(path, []byte(`{"secrets":{"g":"Bearer abc"}}`+"\n"))
	}},
}

// anEmptyFile is an empty file of the mode in a folder of its own, outside the folder written to.
func anEmptyFile(t *testing.T, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.WriteFile(path, nil, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	return path
}

// modeOf is what a failure says of a file: its mode, or why there is none.
func modeOf(info os.FileInfo, err error) any {
	if err != nil {
		return err
	}
	return info.Mode()
}

func TestPrivateFilesNeverFollowALinkLeftWhereTheyAreWritten(t *testing.T) {
	for _, writer := range privateWriters {
		t.Run(writer.label, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), writer.name)
			elsewhere := anEmptyFile(t, 0o644)
			if err := os.Symlink(elsewhere, path+".partial"); err != nil {
				t.Fatal(err)
			}

			if err := writer.write(path); err != nil {
				t.Fatal(err)
			}

			if text, err := os.ReadFile(elsewhere); err != nil || len(text) != 0 {
				t.Errorf("the link's target holds %d bytes, %v, want none written through the link", len(text), err)
			}
			if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
				t.Errorf("%s = %v, want a file of its own of mode 600", path, modeOf(info, err))
			}
		})
	}
}

func TestPrivateFilesNeverWriteIntoAFileLeftOpenWhereTheyAreWritten(t *testing.T) {
	for _, writer := range privateWriters {
		t.Run(writer.label, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), writer.name)
			if err := os.WriteFile(path+".partial", nil, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path+".partial", 0o644); err != nil {
				t.Fatal(err)
			}
			opened, err := os.Open(path + ".partial")
			if err != nil {
				t.Fatal(err)
			}
			defer opened.Close()

			if err := writer.write(path); err != nil {
				t.Fatal(err)
			}

			if text, err := io.ReadAll(opened); err != nil || len(text) != 0 {
				t.Errorf("a file another opened beside %s holds %d bytes, %v, want none", path, len(text), err)
			}
		})
	}
}

func TestPrivateFilesRefuseALinkInTheirPlace(t *testing.T) {
	for _, writer := range privateWriters {
		t.Run(writer.label, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), writer.name)
			elsewhere := anEmptyFile(t, 0o644)
			if err := os.Symlink(elsewhere, path); err != nil {
				t.Fatal(err)
			}

			if err := writer.write(path); err == nil {
				t.Errorf("writing %s, a link, passed, want a refusal", writer.name)
			}

			if info, err := os.Lstat(path); err != nil || info.Mode()&os.ModeSymlink == 0 {
				t.Errorf("%s = %v, want the link left as it was", path, modeOf(info, err))
			}
			if text, err := os.ReadFile(elsewhere); err != nil || len(text) != 0 {
				t.Errorf("the link's target holds %d bytes, %v, want none", len(text), err)
			}
		})
	}
}

func TestLoadOrMakeRefusesALinkToAKey(t *testing.T) {
	folder := t.TempDir()
	held := filepath.Join(folder, "held-key")
	if _, err := LoadOrMake(held); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(folder, "sealing-key")
	if err := os.Symlink(held, path); err != nil {
		t.Fatal(err)
	}

	if _, err := LoadOrMake(path); err == nil {
		t.Error("LoadOrMake(a link to a key) passed, want a refusal")
	}
}

func TestPrivateFilesLeaveNothingElseInTheirFolder(t *testing.T) {
	for _, writer := range privateWriters {
		t.Run(writer.label, func(t *testing.T) {
			folder := t.TempDir()
			path := filepath.Join(folder, writer.name)

			if err := writer.write(path); err != nil {
				t.Fatal(err)
			}

			entries, err := os.ReadDir(folder)
			if err != nil || len(entries) != 1 || entries[0].Name() != writer.name {
				t.Errorf("the folder holds %v, %v, want %s alone", entries, err, writer.name)
			}
		})
	}
}
