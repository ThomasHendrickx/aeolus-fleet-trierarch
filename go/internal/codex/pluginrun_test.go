package codex

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunKeepsAndNamesTheErrorWhenCodexCannotStart(t *testing.T) {
	err := run(filepath.Join(t.TempDir(), "codex"), "", "plugin", "marketplace", "add")

	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("error = %v, want the execution error kept for errors.Is", err)
	}
	if !strings.Contains(err.Error(), "codex") {
		t.Errorf("error %q does not name the harness", err)
	}
}
