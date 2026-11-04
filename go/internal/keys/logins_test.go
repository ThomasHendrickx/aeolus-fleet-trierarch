package keys

import (
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

func TestAShipsLoginIsItsOwnElseItsHarnesssDefaultElseItsSubscription(t *testing.T) {
	logins := Logins{Configured: &config.Logins{Default: &config.DefaultLogins{ClaudeCode: "apiKey"}, Ships: map[string]string{"scout": "subscription"}}}
	cases := []struct{ harness, ship, want string }{
		{"claude-code", "scout", "subscription"},
		{"claude-code", "builder", "apiKey"},
		{"codex", "builder", "subscription"},
	}
	for _, each := range cases {
		if got := logins.LoginOf(each.harness, each.ship); got != each.want {
			t.Errorf("LoginOf(%s, %s) = %s, want %s", each.harness, each.ship, got, each.want)
		}
	}
	if got := (Logins{}).LoginOf("claude-code", "scout"); got != "subscription" {
		t.Errorf("LoginOf with no logins configured = %s, want subscription", got)
	}
}

func TestASessionStartsOnAKeyOnlyWhileTheKeyIsReady(t *testing.T) {
	files, states := statesOf(t)
	logins := Logins{States: states}

	if got := logins.StartProblem("claude-code", "apiKey", nil, ""); got != "claude-code has no API key on this computer: aeolus-trierarch login claude-code --api-key" {
		t.Fatalf("with no key: %q", got)
	}
	if err := files.Write("claude-code", key); err != nil {
		t.Fatal(err)
	}
	if got := logins.StartProblem("claude-code", "apiKey", nil, ""); got != "" || !logins.IsKeyReady("claude-code") {
		t.Fatalf("with a ready key: %q", got)
	}
	if err := states.Record("claude-code", OutOfCredit, monday); err != nil {
		t.Fatal(err)
	}
	if got := logins.StartProblem("claude-code", "apiKey", nil, ""); got != "claude-code's API key is out of credit since 2026-11-02T09:00:00.000Z: it is checked every 15 minutes, or at once with aeolus-trierarch login claude-code --check" || logins.IsKeyReady("claude-code") {
		t.Fatalf("out of credit: %q", got)
	}
	if err := states.Record("claude-code", Refused, monday.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got := logins.StartProblem("claude-code", "apiKey", nil, ""); got != "claude-code's API key was refused by its vendor since 2026-11-02T10:00:00.000Z: give it a new one with aeolus-trierarch login claude-code --api-key" {
		t.Fatalf("refused: %q", got)
	}
}

func TestASessionOnItsSubscriptionStartsWhateverTheKey(t *testing.T) {
	_, states := statesOf(t)

	if got := (Logins{States: states}).StartProblem("claude-code", "subscription", nil, ""); got != "" {
		t.Fatalf("StartProblem(subscription) = %q, want none", got)
	}
}

// aSubscription has a key in reach of a session in the folder it names, and keeps what each check was asked.
type aSubscription struct {
	folder, problem string
	asked           []map[string]string
}

func (s *aSubscription) Problem(options map[string]string, folder string) string {
	s.asked = append(s.asked, options)
	if folder == s.folder {
		return s.problem
	}
	return ""
}

func TestASessionOnItsSubscriptionCannotStartWhileItsHarnessWouldPutAKeyInReachInItsFolder(t *testing.T) {
	_, states := statesOf(t)
	claudeCode := &aSubscription{folder: "/worktrees/aeolus-fleet/scout", problem: "claude-code would reach an API key on its subscription (apiKeyHelper in /home/.claude/settings.json): remove it, or run the ship on its API key"}
	logins := Logins{States: states, Subscriptions: map[string]Subscription{"claude-code": claudeCode}}
	options := map[string]string{"model": "opus"}

	if got := logins.StartProblem("claude-code", "subscription", options, "/worktrees/aeolus-fleet/scout"); got != claudeCode.problem {
		t.Fatalf("StartProblem in the folder = %q, want %q", got, claudeCode.problem)
	}
	if got := logins.StartProblem("claude-code", "subscription", options, "/worktrees/aeolus-fleet/builder"); got != "" {
		t.Fatalf("StartProblem in another folder = %q, want none", got)
	}
	if len(claudeCode.asked) != 2 || claudeCode.asked[0]["model"] != "opus" {
		t.Fatalf("asked with %v, want the session's options", claudeCode.asked)
	}
}

func TestASessionOnAKeyOrOfAHarnessWithNoCheckIsNotAskedWhatIsInReach(t *testing.T) {
	files, states := statesOf(t)
	if err := files.Write("claude-code", key); err != nil {
		t.Fatal(err)
	}
	claudeCode := &aSubscription{folder: "/worktrees/aeolus-fleet/scout", problem: "a key in reach"}
	logins := Logins{States: states, Subscriptions: map[string]Subscription{"claude-code": claudeCode}}

	if got := logins.StartProblem("claude-code", "apiKey", nil, "/worktrees/aeolus-fleet/scout"); got != "" {
		t.Fatalf("StartProblem on a ready key = %q, want none", got)
	}
	if got := logins.StartProblem("copilot", "subscription", nil, "/worktrees/aeolus-fleet/scout"); got != "" {
		t.Fatalf("StartProblem of copilot = %q, want none", got)
	}
	if len(claudeCode.asked) != 0 {
		t.Fatalf("asked %d times, want never", len(claudeCode.asked))
	}
}
