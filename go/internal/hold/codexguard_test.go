package hold

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTheHoldChecksCodexGuardTrustBeforeFirstAndResumedTurns(t *testing.T) {
	folder := t.TempDir()
	program := filepath.Join(folder, "codex")
	calls := filepath.Join(folder, "calls")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + calls + "'\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}'\n"
	if err := os.WriteFile(program, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	held := aHoldOf(t, Options{
		Harness: "codex",
		Command: []string{program, "exec", "--", "first"},
		PrepareCodexTurn: func(words []string) ([]string, error) {
			if words[len(words)-1] == "refuse" {
				return nil, errors.New("the hook is disabled")
			}
			withHook := append([]string{}, words[:len(words)-2]...)
			return append(withHook, "-c", "guard-hook", "--", words[len(words)-1]), nil
		},
	})

	eventually(t, "Codex named its thread", func() bool { return read(held.files.SessionID) == "thread-1" })
	if answer, err := Call(held.files.Socket, Request{Call: "send", Line: "resumed"}, time.Second); err != nil || !answer.IsOK {
		t.Fatalf("resume = %+v, %v, want Codex started", answer, err)
	}
	if answer, err := Call(held.files.Socket, Request{Call: "send", Line: "refuse"}, time.Second); err != nil || answer.IsOK || answer.GuardProblem != "the hook is disabled" {
		t.Fatalf("refused resume = %+v, %v, want guard give-back reason", answer, err)
	}
	if got := strings.TrimSpace(read(calls)); got != "exec -c guard-hook -- first\nexec resume thread-1 -c guard-hook -- resumed" {
		t.Fatalf("starts = %q, want only initial and trusted resumed turn with the hook", got)
	}
}
