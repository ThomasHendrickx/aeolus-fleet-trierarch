package ended

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteReportsDirectoryFailure(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "ended"), []byte("block"), 0600); err != nil {
		t.Fatal(err)
	}
	err := Write(home, "ship", End{})
	if err == nil || !strings.Contains(err.Error(), "create ended directory") {
		t.Fatalf("Write(%q, ship) error = %v, want contextual directory error", home, err)
	}
}
