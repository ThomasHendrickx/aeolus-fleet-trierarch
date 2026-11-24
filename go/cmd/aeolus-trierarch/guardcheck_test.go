package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestGuardCheckExitsAtItsDeadlineWhenItsWorkIsStuck runs guard check as the hook does, its state a pipe no one writes, so reading
// it never ends: the process itself refuses the call and exits at its 5-second deadline, before the hook's timeout.
func TestGuardCheckExitsAtItsDeadlineWhenItsWorkIsStuck(t *testing.T) {
	program := filepath.Join(t.TempDir(), "aeolus-trierarch")
	if output, err := exec.Command("go", "build", "-o", program, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, output)
	}
	home := t.TempDir()
	trierarch := filepath.Join(home, ".aeolus", "trierarch")
	if err := os.MkdirAll(trierarch, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(trierarch, "state.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(program, "guard", "check", "--ship", "shp_01m6jyczpnpp5c0vxh54c966cy")
	command.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	command.Stdin = strings.NewReader(`{"tool_name":"Read","tool_input":{"file_path":"README.md"},"cwd":"/"}`)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	started := time.Now()
	done := make(chan error, 1)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { done <- command.Wait() }()
	var err error
	select {
	case err = <-done:
	case <-time.After(15 * time.Second):
		_ = command.Process.Kill()
		t.Fatal("guard check still ran 15 seconds after it started")
	}
	took := time.Since(started)
	var exited *exec.ExitError
	if !errors.As(err, &exited) || exited.ExitCode() != 2 || strings.TrimSpace(stderr.String()) != "Refused by the guard: guard failed: deadline." {
		t.Fatalf("guard check = %v, %q, want exit 2 and the deadline refusal", err, stderr.String())
	}
	if took < 4*time.Second || took > 8*time.Second {
		t.Fatalf("guard check exited after %s, want at its 5-second deadline", took)
	}
}
