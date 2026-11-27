package plugin

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPreservedVersionPathNamesTheKeptPluginFolder(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "cache")
	newer := filepath.Join(cache, "0.42.0")
	if err := os.MkdirAll(newer, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := RetireNewer(cache, "0.41.0", now, []time.Time{now}); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join("..", ".aeolus-fleet-kept-versions", "0.42.0", "plugin")
	if got, err := os.Readlink(newer); err != nil || got != want {
		t.Fatalf("preserved version link = %q, %v, want %q", got, err, want)
	}
}

func TestCacheLockFailureNamesTheOperation(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "cache")
	if err := os.Mkdir(cache, 0o700); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(filepath.Dir(cache), ".aeolus-fleet-update.lock")
	if err := os.Mkdir(lock, 0o700); err != nil {
		t.Fatal(err)
	}
	err := WithCacheLock(cache, func() error {
		t.Fatal("action ran without the lock")
		return nil
	})
	if !errors.Is(err, syscall.EISDIR) || !strings.Contains(err.Error(), "open plugin cache lock") {
		t.Fatalf("WithCacheLock = %v, want the lock operation and EISDIR", err)
	}
}
