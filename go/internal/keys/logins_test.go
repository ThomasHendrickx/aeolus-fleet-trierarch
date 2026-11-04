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

	if got := logins.StartProblem("claude-code", "apiKey"); got != "claude-code has no API key on this computer: aeolus-trierarch login claude-code --api-key" {
		t.Fatalf("with no key: %q", got)
	}
	if err := files.Write("claude-code", key); err != nil {
		t.Fatal(err)
	}
	if got := logins.StartProblem("claude-code", "apiKey"); got != "" || !logins.IsKeyReady("claude-code") {
		t.Fatalf("with a ready key: %q", got)
	}
	if err := states.Record("claude-code", OutOfCredit, monday); err != nil {
		t.Fatal(err)
	}
	if got := logins.StartProblem("claude-code", "apiKey"); got != "claude-code's API key is out of credit since 2026-11-02T09:00:00.000Z: it is checked every 15 minutes, or at once with aeolus-trierarch login claude-code --check" || logins.IsKeyReady("claude-code") {
		t.Fatalf("out of credit: %q", got)
	}
	if err := states.Record("claude-code", Refused, monday.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got := logins.StartProblem("claude-code", "apiKey"); got != "claude-code's API key was refused by its vendor since 2026-11-02T10:00:00.000Z: give it a new one with aeolus-trierarch login claude-code --api-key" {
		t.Fatalf("refused: %q", got)
	}
}

func TestASessionOnItsSubscriptionStartsWhateverTheKey(t *testing.T) {
	_, states := statesOf(t)

	if got := (Logins{States: states}).StartProblem("claude-code", "subscription"); got != "" {
		t.Fatalf("StartProblem(subscription) = %q, want none", got)
	}
}
