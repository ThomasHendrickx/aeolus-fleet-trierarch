package main

import (
	"context"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/codex"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/modelproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/prompt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

// startedSessions notes every session started, as the runtime would run it.
type startedSessions struct {
	started []sessions.Start
}

func (s *startedSessions) List() ([]sessions.Observed, error) { return nil, nil }
func (s *startedSessions) Stop(shipID string) error           { return nil }
func (s *startedSessions) Start(session sessions.Start) error {
	s.started = append(s.started, session)
	return nil
}
func (s *startedSessions) Send(shipID string, line string) error { return nil }
func (s *startedSessions) Interrupt(shipID string) error         { return nil }
func (s *startedSessions) Root(shipID string) int                { return 0 }

// codexListing is a Codex whose CLI says its version and lists the models given, whichever are set when it is asked.
type codexListing struct {
	models []string
}

func (c *codexListing) Version(ctx context.Context) (string, bool) { return "0.200.0", true }
func (c *codexListing) Detect(ctx context.Context, version string, previous *detection.Harness, now time.Time) (detection.Harness, bool) {
	return detection.Harness{Version: version, Options: map[string]config.Option{"model": detection.OptionOf(c.models, "-m")}}, true
}

// codexConfiguration is Codex's configuration and hooks for a folder with nothing of the user's: what the codex program answers in place of it.
type codexConfiguration struct{}

func (codexConfiguration) TrustAeolusHooks(folder string) ([]string, error) { return nil, nil }
func (codexConfiguration) ConfiguredFor(folder string, overrides []string) (codex.Configured, error) {
	return codex.Configured{}, nil
}

func TestARequestForAModelCodexListsOnlyOnceConfirmedAgainAfterTheTrierarchStartedLaunchesTheWiredCodexWithItsFlag(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	listing := &codexListing{models: []string{"gpt-6.1-sol"}}
	held := &offers{configured: config.Configuration{Harnesses: map[string]config.Harness{"codex": {Flags: []string{}, Options: map[string]config.Option{}}}}}
	detect := detection.Detection{Detectors: map[string]detection.Detector{"codex": listing}, Store: detection.File{Path: filepath.Join(t.TempDir(), "detected.json")}, Now: time.Now, Warn: func(string) {}, Given: held.set}
	if _, err := detect.Detect(context.Background(), []string{"codex"}, detection.ByStart); err != nil {
		t.Fatal(err)
	}
	running := &startedSessions{}
	env := map[string]string{"AEOLUS_CODEX_PLUGIN_ROOT": filepath.Join(filepath.Dir(file), "..", "..", "..", "plugins", "aeolus-fleet"), "AEOLUS_CODEX_PLUGIN_DATA": t.TempDir()}
	harnesses, _, err := harnessesOf(held.configured, paths.Paths{Sessions: t.TempDir()}, env, t.TempDir(), running, modelproxy.Runtime{}, held)
	if err != nil {
		t.Fatal(err)
	}
	wired, ok := harnesses["codex"].(codex.Harness)
	if !ok {
		t.Fatalf("harnesses[codex] = %T, want codex.Harness", harnesses["codex"])
	}
	// The codex program answers its hooks and configuration: only they are stood in for, the settings stay as wired.
	wired.Hooks, wired.Configuration = codexConfiguration{}, codexConfiguration{}

	// Codex lists the model only once the request has its models confirmed again, as the pass asks before it crews it (#333).
	listing.models = []string{"gpt-6.1-sol", "gpt-6.1-terra"}
	confirmModelsOf(detect)("codex")
	entry := reconciler.Entry{ShipID: "shp_01m6jyczpnpp5c0vxh54c966cy", ShipName: "scout", Harness: "codex", Folder: t.TempDir(), Options: map[string]string{"model": "gpt-6.1-terra"}, FirstPrompt: "Review PR 12"}
	if err := wired.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if want := codex.CommandLine([]string{"-m", "gpt-6.1-terra"}, prompt.First("Review PR 12"), true); len(running.started) != 1 || !slices.Equal(running.started[0].Command, want) {
		t.Fatalf("started %+v, want %q", running.started, want)
	}
}
