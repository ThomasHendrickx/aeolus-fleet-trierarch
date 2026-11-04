package claudecode

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/prompt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"

type aRuntime struct {
	started []sessions.Start
	sent    []string
}

func (r *aRuntime) Start(session sessions.Start) error {
	r.started = append(r.started, session)
	return nil
}

func (r *aRuntime) Send(shipID string, line string) error {
	r.sent = append(r.sent, line)
	return nil
}

type anOnboarding struct{ completed int }

func (o *anOnboarding) CompleteOnboarding() error {
	o.completed++
	return nil
}

func aHarness(t *testing.T) (Harness, *aRuntime, *anOnboarding) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	running, onboarding := &aRuntime{}, &anOnboarding{}
	events := t.TempDir()
	return Harness{
		Plugin:     plugin.Plugin{Root: filepath.Join(filepath.Dir(file), "..", "..", "..", "plugins", "aeolus-fleet"), Data: t.TempDir(), Crews: t.TempDir()},
		Runtime:    running,
		Settings:   config.Harness{Flags: []string{"--model", "opus"}, Options: map[string]config.Option{}},
		Projects:   t.TempDir(),
		Onboarding: onboarding,
		Events:     func(shipID string) string { return filepath.Join(events, shipID+".jsonl") },
	}, running, onboarding
}

func anEntry(t *testing.T) reconciler.Entry {
	t.Helper()
	return reconciler.Entry{ShipID: scout, ShipName: "scout", Harness: "claude-code", Folder: t.TempDir(), Options: map[string]string{}, FirstPrompt: "Review PR 12"}
}

func TestAFirstStartRunsClaudeCodeInTheFolderWithItsLaunchIdAndItsFirstPrompt(t *testing.T) {
	harness, running, onboarding := aHarness(t)
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if len(running.started) != 1 || running.started[0].Folder != entry.Folder || running.started[0].Harness != "claude-code" || running.started[0].Env["AEOLUS_LAUNCH"] != "launch-1" || slices.Contains(running.started[0].Command, "--continue") || !slices.Contains(running.started[0].Command, "opus") {
		t.Fatalf("started %+v", running.started)
	}
	if !slices.Equal(running.sent, []string{UserLine(prompt.First("Review PR 12"))}) || onboarding.completed != 1 {
		t.Fatalf("sent %q, onboarding %d", running.sent, onboarding.completed)
	}
}

func TestAStartAgainWakesTheSessionAndContinuesItsConversation(t *testing.T) {
	harness, running, _ := aHarness(t)
	entry := anEntry(t)
	kept := filepath.Join(harness.Projects, notLetterOrDigit.ReplaceAllString(entry.Folder, "-"))
	if err := os.MkdirAll(kept, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(kept, "a.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := harness.Launch(entry, false, "launch-2"); err != nil {
		t.Fatal(err)
	}

	if !slices.Contains(running.started[0].Command, "--continue") || !slices.Equal(running.sent, []string{UserLine(WakePrompt())}) {
		t.Fatalf("started %+v, sent %q", running.started, running.sent)
	}
}

func TestAStartAgainWithNoConversationStartsFresh(t *testing.T) {
	harness, running, _ := aHarness(t)

	if err := harness.Launch(anEntry(t), false, "launch-2"); err != nil {
		t.Fatal(err)
	}

	if slices.Contains(running.started[0].Command, "--continue") {
		t.Fatalf("started %+v", running.started)
	}
}

func TestALaunchWithNoActivityNamesTheErrorClaudeCodeLastGave(t *testing.T) {
	harness, _, _ := aHarness(t)
	entry := anEntry(t)
	entry.LaunchID = "launch-1"
	events := `{"type":"system","subtype":"init"}` + "\n" + `{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}` + "\n"
	if err := os.WriteFile(harness.Events(scout), []byte(events), 0o600); err != nil {
		t.Fatal(err)
	}

	seen := harness.LaunchSeen(entry)

	if seen != (reconciler.LaunchSeen{Kind: reconciler.LaunchNone, Cause: "Not logged in · Please run /login"}) {
		t.Fatalf("seen %+v", seen)
	}
}

func TestAPluginWhoseScriptsAreGoneIsWhyNoSessionCanStart(t *testing.T) {
	harness, _, _ := aHarness(t)
	harness.Plugin.Root = t.TempDir()

	if harness.Problem() == nil {
		t.Fatalf("no problem with a plugin with no scripts")
	}
}

func (r *aRuntime) Interrupt(shipID string) error {
	r.sent = append(r.sent, "interrupt")
	return nil
}

// withPushAnswering makes the harness's plugin a stand-in whose aeolus-push.sh prints the line and exits with the code given.
func withPushAnswering(t *testing.T, harness Harness, line string, code int) Harness {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\necho '" + line + "'\nexit " + strconv.Itoa(code) + "\n"
	if err := os.WriteFile(filepath.Join(root, "scripts", "aeolus-push.sh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	harness.Plugin.Root = root
	return harness
}

func TestAHandOverTypesThePluginsLineIntoTheSessionAsAWake(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness = withPushAnswering(t, harness, "Aeolus handed a message", 0)

	isHanded, err := harness.HandOver(anEntry(t))

	if err != nil || !isHanded {
		t.Fatalf("HandOver = %v %v, want handed", isHanded, err)
	}
	want := UserLine("Aeolus handed a message " + prompt.NoTerminalQuestions)
	if !slices.Equal(running.sent, []string{want}) {
		t.Fatalf("sent %q, want %q", running.sent, want)
	}
}

func TestNothingHandedOverTypesNothing(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness = withPushAnswering(t, harness, "", 1)

	isHanded, err := harness.HandOver(anEntry(t))

	if err != nil || isHanded || len(running.sent) != 0 {
		t.Fatalf("HandOver = %v %v, sent %q, want nothing", isHanded, err, running.sent)
	}
}

func TestAForcedMessageStopsABusyTurnBeforeItsLineGoesIn(t *testing.T) {
	cases := []struct {
		isTurnBusy bool
		want       []string
	}{
		{true, []string{"interrupt", UserLine("Aeolus forced " + prompt.NoTerminalQuestions)}},
		{false, []string{UserLine("Aeolus forced " + prompt.NoTerminalQuestions)}},
	}
	for _, c := range cases {
		harness, running, _ := aHarness(t)
		harness = withPushAnswering(t, harness, "Aeolus forced", 0)

		isHanded, err := harness.ForceOver(anEntry(t), c.isTurnBusy)

		if err != nil || !isHanded || !slices.Equal(running.sent, c.want) {
			t.Fatalf("ForceOver(busy %v) = %v %v, sent %q, want %q", c.isTurnBusy, isHanded, err, running.sent, c.want)
		}
	}
}

func TestASessionOnAnAPIKeyStartsWithTheProxyAsItsBaseURLAndAFreshTokenOfItsOwn(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	entry := anEntry(t)
	entry.Login = "apiKey"

	for range 2 {
		if err := harness.Launch(entry, false, "launch-1"); err != nil {
			t.Fatal(err)
		}
	}

	first, second := running.started[0], running.started[1]
	if first.Env["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:41000/anthropic" || first.ProxyToken == nil || first.ProxyToken.Variable != "ANTHROPIC_AUTH_TOKEN" || first.ProxyToken.Harness != "claude-code" || first.ProxyToken.Token == "" {
		t.Fatalf("started %+v with token %+v, want the proxy's address and a token in ANTHROPIC_AUTH_TOKEN", first, first.ProxyToken)
	}
	if second.ProxyToken == nil || second.ProxyToken.Token == first.ProxyToken.Token {
		t.Fatal("the second start has the first one's token, want a fresh one")
	}
	if _, ok := first.Env["ANTHROPIC_AUTH_TOKEN"]; ok {
		t.Fatal("the token is among the variables given on the hold's command line")
	}
}

func TestASessionOnItsSubscriptionGetsNoRouteToTheProxyAndNoToken(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	entry := anEntry(t)
	entry.Login = "subscription"

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if _, ok := running.started[0].Env["ANTHROPIC_BASE_URL"]; ok || running.started[0].ProxyToken != nil {
		t.Fatalf("started %+v, want no proxy and no token", running.started[0])
	}
}

func TestASessionOnAnAPIKeyDoesNotStartBeforeTheProxyListens(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "", false }
	entry := anEntry(t)
	entry.Login = "apiKey"

	err := harness.Launch(entry, true, "launch-1")

	if err == nil || len(running.started) != 0 {
		t.Fatalf("Launch = %v, started %d, want an error and nothing started", err, len(running.started))
	}
}
