package main

import (
	"slices"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
)

func TestAHarnessLaunchesWithAModelItsModelsListOnlyOnceConfirmedAgainAfterTheTrierarchStarted(t *testing.T) {
	configured := config.Configuration{Harnesses: map[string]config.Harness{"codex": {Flags: []string{}, Options: map[string]config.Option{}}}}
	held := &offers{configured: configured, detected: detection.Detected{"codex": {Version: "0.200.0", Options: map[string]config.Option{"model": detection.OptionOf([]string{"gpt-6.1-sol"}, "-m")}}}}
	settings := settingsOf(held, "codex")

	// Detection confirms Codex's models again for the request, as the pass asks before it crews it (#333), and gives what it found to the offers.
	held.set(detection.Detected{"codex": {Version: "0.200.0", Options: map[string]config.Option{"model": detection.OptionOf([]string{"gpt-6.1-sol", "gpt-6.1-terra"}, "-m")}}})

	if got, want := settings().EffectiveFlags(map[string]string{"model": "gpt-6.1-terra"}), []string{"-m", "gpt-6.1-terra"}; !slices.Equal(got, want) {
		t.Errorf("flags = %q, want %q", got, want)
	}
}
