package copilot

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
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

func (r *aRuntime) Interrupt(shipID string) error {
	r.sent = append(r.sent, "interrupt")
	return nil
}

func aHarness(t *testing.T) (Harness, *aRuntime) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	running := &aRuntime{}
	events := t.TempDir()
	return Harness{
		Plugin:   plugin.Plugin{Root: filepath.Join(filepath.Dir(file), "..", "..", "..", "plugins", "aeolus-fleet"), Data: t.TempDir(), Crews: t.TempDir()},
		Runtime:  running,
		Settings: config.Harness{Flags: []string{"--model", "gpt-5"}, Options: map[string]config.Option{}},
		Events:   func(shipID string) string { return filepath.Join(events, shipID+".jsonl") },
		Version:  func() (string, bool) { return "1.0.105", true },
	}, running
}

func anEntry(t *testing.T) reconciler.Entry {
	t.Helper()
	return reconciler.Entry{ShipID: scout, ShipName: "scout", Harness: "copilot", Folder: t.TempDir(), Options: map[string]string{}, FirstPrompt: "Review PR 12", Login: "subscription"}
}

func TestAFirstStartRunsCopilotInTheFolderWithItsFirstPromptAndItsLaunchId(t *testing.T) {
	harness, running := aHarness(t)
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	want := CommandLine([]string{"--model", "gpt-5"}, prompt.First("Review PR 12"), "")
	if len(running.started) != 1 || !slices.Equal(running.started[0].Command, want) || running.started[0].Folder != entry.Folder || running.started[0].Harness != "copilot" || running.started[0].Env["AEOLUS_LAUNCH"] != "launch-1" || running.started[0].ProxyToken != nil {
		t.Fatalf("started %+v, want %q in the folder as copilot with its launch id and no token", running.started, want)
	}
}

func TestAStartAgainResumesTheSessionItsLastTurnNamedWithTheWake(t *testing.T) {
	harness, running := aHarness(t)
	if err := os.WriteFile(harness.Events(scout), []byte(`{"type":"result","sessionId":"copilot-1"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := harness.Launch(anEntry(t), false, "launch-2"); err != nil {
		t.Fatal(err)
	}

	if want := CommandLine([]string{"--model", "gpt-5"}, prompt.Wake(WakePrompt), "copilot-1"); !slices.Equal(running.started[0].Command, want) {
		t.Fatalf("started %q, want %q", running.started[0].Command, want)
	}
}

func TestASessionGetsTheTrierarchsCopilotHomeSoItUsesTheLoginAndPluginFoundThere(t *testing.T) {
	harness, running := aHarness(t)
	harness.CopilotHome = "/home/me/copilot"

	if err := harness.Launch(anEntry(t), true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if got := running.started[0].Env["COPILOT_HOME"]; got != "/home/me/copilot" {
		t.Fatalf("COPILOT_HOME = %q, want /home/me/copilot", got)
	}
}

func TestASessionOnAnAPIKeyIsRefusedAsCopilotSignsInWithTheMachinesOwnLogin(t *testing.T) {
	harness, running := aHarness(t)
	entry := anEntry(t)
	entry.Login = "apiKey"

	if err := harness.Launch(entry, true, "launch-1"); err == nil || !strings.Contains(err.Error(), "copilot login") || len(running.started) != 0 {
		t.Fatalf("Launch = %v, started %d, want refused naming copilot login", err, len(running.started))
	}
}

func TestALaunchWithNoActivityNamesTheErrorCopilotLastGave(t *testing.T) {
	harness, _ := aHarness(t)
	entry := anEntry(t)
	entry.LaunchID = "launch-1"
	if err := os.WriteFile(harness.Events(scout), []byte(`{"type":"aeolus.stderr","line":"Error: Model \"gpt-0\" from --model flag is not available."}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if seen, want := harness.LaunchSeen(entry), (reconciler.LaunchSeen{Kind: reconciler.LaunchNone, Cause: `Model "gpt-0" from --model flag is not available.`}); seen != want {
		t.Fatalf("LaunchSeen = %+v, want %+v", seen, want)
	}
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

func TestAHandOverIsATurnOfThePluginsLineAsAWake(t *testing.T) {
	harness, running := aHarness(t)
	harness = withPushAnswering(t, harness, "Aeolus handed a message", 0)

	isHanded, err := harness.HandOver(anEntry(t))

	if want := []string{"Aeolus handed a message " + prompt.NoTerminalQuestions}; err != nil || !isHanded || !slices.Equal(running.sent, want) {
		t.Fatalf("HandOver = %v %v, sent %q, want %q", isHanded, err, running.sent, want)
	}
}

func TestAForcedMessageStopsABusyTurnBeforeItsTurnStarts(t *testing.T) {
	harness, running := aHarness(t)
	harness = withPushAnswering(t, harness, "Aeolus forced", 0)

	isHanded, err := harness.ForceOver(anEntry(t), true)

	if want := []string{"interrupt", "Aeolus forced " + prompt.NoTerminalQuestions}; err != nil || !isHanded || !slices.Equal(running.sent, want) {
		t.Fatalf("ForceOver = %v %v, sent %q, want %q", isHanded, err, running.sent, want)
	}
}

func TestCopilotIsNotOfferedWithoutItsPluginOrOnABuildItsHooksAreNotProvenOn(t *testing.T) {
	for _, test := range []struct {
		name        string
		isInstalled bool
		version     string
		isDetected  bool
		want        string
	}{
		{"its plugin not installed", false, "1.0.105", true, "its aeolus-fleet plugin is not installed for Copilot: copilot plugin install aeolus-fleet@aeolus-fleet"},
		{"no version found", true, "", false, "its Copilot CLI version is not detected yet: the hooks of its aeolus-fleet plugin are proven on Copilot CLI 1.0.105"},
		{"a build not proven", true, "1.0.106", true, "Copilot CLI 1.0.106 is not proven: the hooks of its aeolus-fleet plugin are proven on Copilot CLI 1.0.105"},
	} {
		t.Run(test.name, func(t *testing.T) {
			harness, _ := aHarness(t)
			if !test.isInstalled {
				harness.Plugin.Root = t.TempDir()
			}
			harness.Version = func() (string, bool) { return test.version, test.isDetected }

			if err := harness.Problem(); err == nil || err.Error() != test.want {
				t.Fatalf("Problem = %v, want %q", err, test.want)
			}
		})
	}
}

func TestCopilotIsOfferedWithItsPluginOnAProvenBuild(t *testing.T) {
	harness, _ := aHarness(t)

	if err := harness.Problem(); err != nil {
		t.Fatalf("Problem = %v, want none", err)
	}
}

func TestCopilotIsNotOfferedInContainersWhereItIsNotProven(t *testing.T) {
	harness, _ := aHarness(t)
	harness.IsInContainer = true

	if got := harness.NotOfferedReason(); got != "Copilot is not proven in a container: the container runtime runs claude-code only" {
		t.Fatalf("NotOfferedReason = %q", got)
	}
}
