package claudecode

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
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
	if !slices.Equal(running.sent, []string{UserLine(FirstPrompt("Review PR 12"))}) || onboarding.completed != 1 {
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
