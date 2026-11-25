package codex

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCodexWrapperRefusesWhenTheWatchdogCannotAnswer(t *testing.T) {
	for _, tt := range []struct{ name, script string }{
		{"missing executable", ""},
		{"crashed", "exit 1"},
		{"killed", "kill -KILL $$"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			program := filepath.Join(t.TempDir(), "guard program's binary")
			if tt.script != "" {
				if err := os.WriteFile(program, []byte("#!/bin/sh\n"+tt.script+"\n"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.CommandContext(t.Context(), "/bin/sh", "-c", guardCommand(program))
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			stdout, err := cmd.Output()
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 2 || len(stdout) != 0 ||
				!strings.Contains(stderr.String(), "Refused by the guard: guard failed") {
				t.Fatalf("wrapper output = %q, %q, %v, want only an exit-2 refusal", stdout, stderr.String(), err)
			}
		})
	}
}

func TestGuardWatchdogKillsAStalledCheckBeforeCodexStopsWaiting(t *testing.T) {
	program := filepath.Join(t.TempDir(), "guard")
	if err := os.WriteFile(program, []byte("#!/bin/sh\nexec sleep 30\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	code := GuardWatchdog(t.Context(), program, nil, nil)
	if elapsed := time.Since(start); code != 1 || elapsed < 4*time.Second || elapsed >= 9*time.Second {
		t.Fatalf("watchdog exited %d after %s, want a failure at the five-second deadline", code, elapsed)
	}
}

func TestGuardWatchdogDiscardsStdoutAndKeepsOnlyAValidRefusalStatus(t *testing.T) {
	for _, tt := range []struct {
		name, script, stderr string
		code                 int
	}{
		{"allow", "printf junk", "", 0},
		{"refusal", "printf 'refused\\n' >&2; exit 2", "refused\n", 2},
		{"crash", "kill -KILL $$", "", 1},
	} {
		t.Run(tt.name, func(t *testing.T) {
			program := filepath.Join(t.TempDir(), "guard")
			if err := os.WriteFile(program, []byte("#!/bin/sh\n"+tt.script+"\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			var stderr bytes.Buffer
			if code := GuardWatchdog(t.Context(), program, nil, &stderr); code != tt.code || stderr.String() != tt.stderr {
				t.Fatalf("watchdog = %d, %q, want %d, %q", code, stderr.String(), tt.code, tt.stderr)
			}
		})
	}
}
