package hold

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHoldRotatesEventsAtTenMegabytesAndKeepsOneBackup(t *testing.T) {
	const limit = 10_000_000
	existing := strings.Repeat("0\n", (limit-2)/2)
	fullLine := "\"" + strings.Repeat("x", limit-3) + "\"\n"

	for _, tc := range []struct {
		name       string
		output     string
		wantActive string
		wantBackup string
	}{
		{"at the limit", "1\n", existing + "1\n", "old backup\n"},
		{"next event starts a new file", "1\n2\n", "2\n", existing + "1\n"},
		{"next rotation replaces the backup", "1\n" + fullLine + "2\n", "2\n", fullLine},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := shortFolder(t)
			files := FilesOf(dir, ship)
			if err := os.MkdirAll(files.Folder, 0o700); err != nil {
				t.Fatal(err)
			}
			output := filepath.Join(dir, "output")
			backup := files.Events + ".1"
			for path, contents := range map[string]string{
				files.Events: existing,
				backup:       "old backup\n",
				output:       tc.output,
			} {
				if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
					t.Fatal(err)
				}
			}

			if code := Run(Options{Files: files, Folder: dir, Command: []string{"sh", "-c", `cat "$1"`, "harness", output}}); code != 0 {
				t.Fatalf("hold exit code = %d, want 0", code)
			}

			assertEventFile(t, files.Events, tc.wantActive)
			assertEventFile(t, backup, tc.wantBackup)
			if _, err := os.Stat(files.Events + ".2"); !os.IsNotExist(err) {
				t.Fatalf("second backup stat error = %v, want file not found", err)
			}
		})
	}
}

func assertEventFile(t *testing.T, path, want string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != want {
		t.Fatalf("%s contents differ: got %d bytes, want %d bytes", filepath.Base(path), len(data), len(want))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("%s mode = %o, want 600", filepath.Base(path), info.Mode().Perm())
	}
}
