// Package trashtest makes, for tests, a folder the host user cannot remove or move, as a session can leave one in its clone or its
// ship's home: on Linux a folder owned by a mapped id, on macOS a file or folder flagged immutable.
package trashtest

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// Unremovable makes `<folder>/a/f`, which the host user cannot remove. Whatever is left of it under root is removed after the test.
// The test is skipped where neither can be made.
func Unremovable(t *testing.T, root string, folder string) {
	t.Helper()
	inner := filepath.Join(folder, "a")
	if err := os.MkdirAll(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inner, "f"), []byte("f\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	switch runtime.GOOS {
	case "linux":
		if _, err := exec.LookPath("podman"); err != nil {
			t.Skip("needs podman to own a folder by a mapped id")
		}
		run(t, "podman", "unshare", "chown", "-R", "1:1", inner)
	case "darwin":
		run(t, "chflags", "uchg", filepath.Join(inner, "f"))
	default:
		t.Skipf("no folder the host cannot remove is made on %s", runtime.GOOS)
	}
	t.Cleanup(func() { _ = RemoveAsRuntime(root) })
}

// Unmovable makes the folder itself one the host user can neither give its own write nor move: on Linux owned by a mapped id, on
// macOS flagged immutable. Whatever is left of it under root is removed after the test. The test is skipped where neither can be made.
func Unmovable(t *testing.T, root string, folder string) {
	t.Helper()
	switch runtime.GOOS {
	case "linux":
		if _, err := exec.LookPath("podman"); err != nil {
			t.Skip("needs podman to own a folder by a mapped id")
		}
		run(t, "podman", "unshare", "chown", "1:1", folder)
	case "darwin":
		run(t, "chflags", "uchg", folder)
	default:
		t.Skipf("no folder the host cannot move is made on %s", runtime.GOOS)
	}
	t.Cleanup(func() { _ = RemoveAsRuntime(root) })
}

// MoveAsRuntime moves the folder Unmovable made to the path, as the runtime's user namespace moves it.
func MoveAsRuntime(from string, to string) error {
	if runtime.GOOS == "darwin" {
		if said, err := exec.Command("chflags", "nouchg", from).CombinedOutput(); err != nil {
			return fmt.Errorf("chflags: %w: %s", err, said)
		}
		return os.Rename(from, to)
	}
	if said, err := exec.Command("podman", "unshare", "mv", "-T", "--", from, to).CombinedOutput(); err != nil {
		return fmt.Errorf("podman unshare mv: %w: %s", err, said)
	}
	return nil
}

// RemoveAsRuntime removes the path whatever Unremovable left in it, as the runtime's user namespace removes it.
func RemoveAsRuntime(path string) error {
	if runtime.GOOS == "darwin" {
		if said, err := exec.Command("chflags", "-R", "nouchg", path).CombinedOutput(); err != nil {
			return fmt.Errorf("chflags: %w: %s", err, said)
		}
		return os.RemoveAll(path)
	}
	if said, err := exec.Command("podman", "unshare", "rm", "-rf", "--", path).CombinedOutput(); err != nil {
		return fmt.Errorf("podman unshare rm: %w: %s", err, said)
	}
	return nil
}

func run(t *testing.T, name string, args ...string) {
	t.Helper()
	if said, err := exec.Command(name, args...).CombinedOutput(); err != nil {
		t.Fatalf("%s %v: %v: %s", name, args, err, said)
	}
}
