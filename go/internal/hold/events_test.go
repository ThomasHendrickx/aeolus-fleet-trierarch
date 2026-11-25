package hold

import (
	"errors"
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

func TestAppendLineReportsThatTheEventsLogIsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	log, err := openEventLog(path)
	if err != nil {
		t.Fatal(err)
	}
	log.close()
	if err := log.appendLine("new event"); !errors.Is(err, os.ErrClosed) || !strings.Contains(err.Error(), path) {
		t.Fatalf("appendLine after close = %v, want a closed error naming the events file", err)
	}
}

func TestAppendLineKeepsWritingAndReportsFailedRotation(t *testing.T) {
	log := eventsWithBlockedRotation(t)
	if err := log.appendLine("new event"); err == nil || !strings.Contains(err.Error(), "rotate events") {
		t.Fatalf("appendLine = %v, want an event rotation error", err)
	}
	data, err := os.ReadFile(log.path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(data), "new event\n") {
		t.Fatal("active events did not retain the line after a failed rotation")
	}
}

func TestAppendLineReportsBothRotationAndWriteFailures(t *testing.T) {
	log := eventsWithBlockedRotation(t)
	if err := log.file.Close(); err != nil {
		t.Fatal(err)
	}
	err := log.appendLine("new event")
	var rotation *os.LinkError
	if !errors.As(err, &rotation) || !errors.Is(err, os.ErrClosed) || !strings.Contains(err.Error(), "write events") {
		t.Fatalf("appendLine = %v, want both rotation and event write errors", err)
	}
}

func TestAppendLineReportsFailureToReopenEvents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	// After rotation the old descriptor is gone and the active path must be opened.
	log := &eventLog{path: path}
	if err := log.appendLine("new event"); err == nil || !strings.Contains(err.Error(), "open events") {
		t.Fatalf("appendLine = %v, want an event open error", err)
	}
}

func TestHoldRecordsEventAppendFailure(t *testing.T) {
	log := eventsWithBlockedRotation(t)
	h := &held{events: log}
	h.onLine("harness output")

	diagnostic, err := os.ReadFile(log.path + ".error")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(diagnostic), "rotate events") || strings.Contains(string(diagnostic), "harness output") {
		t.Fatalf("event log diagnostic = %q, want the rotation error without harness output", diagnostic)
	}
}

func eventsWithBlockedRotation(t *testing.T) *eventLog {
	t.Helper()
	path := filepath.Join(t.TempDir(), "events.jsonl")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(path, eventLogLimit); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path+".1", 0o700); err != nil {
		t.Fatal(err)
	}
	log, err := openEventLog(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.close)
	return log
}
