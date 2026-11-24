package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// aStuckGuardCheck is guard check as the hook runs it, its state a pipe no one writes, so reading it never ends.
func aStuckGuardCheck(t *testing.T) *exec.Cmd {
	t.Helper()
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
	return command
}

// exitOf runs the command to its end, at most 15 seconds: after how long, and how it exited.
func exitOf(t *testing.T, command *exec.Cmd) (time.Duration, error) {
	t.Helper()
	started := time.Now()
	done := make(chan error, 1)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		return time.Since(started), err
	case <-time.After(15 * time.Second):
		_ = command.Process.Kill()
		t.Fatal("guard check still ran 15 seconds after it started")
		return 0, nil
	}
}

func exitCodeOf(err error) int {
	var exited *exec.ExitError
	if !errors.As(err, &exited) {
		return 0
	}
	return exited.ExitCode()
}

// TestGuardCheckExitsAtItsDeadlineWhenItsWorkIsStuck: the process itself refuses the call and exits at its 5-second deadline, before
// the hook's timeout.
func TestGuardCheckExitsAtItsDeadlineWhenItsWorkIsStuck(t *testing.T) {
	command := aStuckGuardCheck(t)
	var stderr bytes.Buffer
	command.Stderr = &stderr

	took, err := exitOf(t, command)

	if exitCodeOf(err) != 2 || strings.TrimSpace(stderr.String()) != "Refused by the guard: guard failed: deadline." {
		t.Fatalf("guard check = %v, %q, want exit 2 and the deadline refusal", err, stderr.String())
	}
	if took < 4*time.Second || took > 5500*time.Millisecond {
		t.Fatalf("guard check exited after %s, want within its 5-second deadline", took)
	}
}

// TestGuardCheckExitsWithinItsDeadlineWhenItsAnswerCannotBeWritten: its stderr a pipe no one reads that is full already, the refusal
// it writes at its deadline never ends, and the process exits with 2 all the same, within its deadline.
func TestGuardCheckExitsWithinItsDeadlineWhenItsAnswerCannotBeWritten(t *testing.T) {
	command := aStuckGuardCheck(t)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reader.Close() }()
	if err := writer.SetWriteDeadline(time.Now().Add(500 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := writer.Write(bytes.Repeat([]byte("x"), 4096)); err != nil {
			break
		}
	}
	if err := writer.SetWriteDeadline(time.Time{}); err != nil {
		t.Fatal(err)
	}
	command.Stderr, command.Stdout = writer, io.Discard

	took, err := exitOf(t, command)
	_ = writer.Close()

	if exitCodeOf(err) != 2 || took > 5500*time.Millisecond {
		t.Fatalf("guard check = %v after %s, want exit 2 within its 5-second deadline", err, took)
	}
}
