package codex

import (
	"os"
	"path/filepath"
	"testing"
)

// aCodexSaying is a stand-in for `codex` whose `login status` writes the text given, on stderr as Codex does, and exits with the status given.
func aCodexSaying(t *testing.T, said string, status int) string {
	t.Helper()
	program := filepath.Join(t.TempDir(), "codex")
	script := "#!/bin/sh\n[ \"$1 $2\" = 'login status' ] || exit 2\nprintf '%s\\n' '" + said + "' >&2\nexit " + string(rune('0'+status)) + "\n"
	if err := os.WriteFile(program, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return program
}

func TestASessionOnItsSubscriptionCannotStartWhileCodexIsLoggedInWithAnAPIKey(t *testing.T) {
	program := aCodexSaying(t, "Logged in using an API key - sk-proj-***ABCD", 0)

	got := Subscription{Program: program}.Problem(nil, "/worktrees/aeolus-fleet/scout")

	if want := "codex is logged in with an API key, not ChatGPT: log Codex in with ChatGPT (codex logout, then codex login), or run the ship on its API key"; got != want {
		t.Fatalf("Problem = %q, want %q", got, want)
	}
}

func TestASessionOnItsSubscriptionStartsWhileCodexIsLoggedInWithChatGPTOrNotAtAll(t *testing.T) {
	cases := []struct {
		said   string
		status int
	}{
		{"Logged in using ChatGPT", 0},
		{"Not logged in", 1},
	}
	for _, each := range cases {
		if got := (Subscription{Program: aCodexSaying(t, each.said, each.status)}).Problem(nil, "/worktrees/aeolus-fleet/scout"); got != "" {
			t.Errorf("Problem when codex says %q = %q, want none", each.said, got)
		}
	}
}
