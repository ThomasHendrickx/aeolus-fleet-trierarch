package codex

import (
	"context"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
)

var detectedNow = time.Date(2026, 10, 8, 15, 0, 0, 0, time.UTC)

// bundledCatalog is `codex debug models --bundled` as codex-cli 0.160.1 prints it, cut to what detection reads.
const bundledCatalog = `{"models":[
{"slug":"gpt-6.1-sol","display_name":"GPT-6.1 Sol","visibility":"list","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"ultra"}]},
{"slug":"gpt-6-luna","display_name":"GPT-6 Luna","visibility":"list","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"low"}]},
{"slug":"gpt-reserve","display_name":"Reserve","visibility":"hide","default_reasoning_level":"low","supported_reasoning_levels":[]}]}`

// liveCatalog is `codex debug models` as codex-cli 0.160.1 prints it on the mac mini, cut to what detection reads: it hides gpt-5.5, which a ChatGPT login may use, and shows gpt-6.1-sol, which it refuses (#392).
const liveCatalog = `{"models":[{"slug":"gpt-6.1-sol","visibility":"list"},{"slug":"gpt-6-luna","visibility":"list"},{"slug":"gpt-5.5","visibility":"hide"}]}`

const neutralFolder = "/tmp/aeolus-trierarch-probe-x1"

// aCodexCLI is Codex 0.160.1: catalog answers `debug models --bundled`, and live, when set, answers `debug models`, which fails without it as on a Codex before it. Each model's probe ends as probes says, confirmed when it says nothing; the probes run are kept in order.
type aCodexCLI struct {
	catalog *detection.Ran
	live    *detection.Ran
	config  string
	probes  map[string]string
	probed  []detection.Command
}

func (c *aCodexCLI) run(_ context.Context, command detection.Command) detection.Ran {
	switch strings.Join(command.Args, " ") {
	case "--version":
		return detection.Ran{Stdout: "codex-cli 0.160.1\n"}
	case "debug models":
		if c.live == nil {
			return detection.Ran{Status: 1, Stderr: "unknown command"}
		}
		return *c.live
	case "debug models --bundled":
		if c.catalog == nil {
			return detection.Ran{Stdout: bundledCatalog}
		}
		return *c.catalog
	}
	c.probed = append(c.probed, command)
	slug := command.Args[slices.Index(command.Args, "-m")+1]
	switch c.probes[slug] {
	case "refused":
		return detection.Ran{Status: 1, Stderr: `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '` + slug + `' model is not supported when using Codex with a ChatGPT account."}}` + "\n"}
	case "unknown":
		return detection.Ran{Status: 1, Stderr: "ERROR: stream disconnected before completion: error sending request\n"}
	}
	return detection.Ran{Stdout: "OK\n"}
}

func (c *aCodexCLI) detector() Detector {
	return Detector{Run: c.run, ReadConfig: func() string { return c.config }, NeutralFolder: func() (string, error) { return neutralFolder, nil }}
}

func (c *aCodexCLI) detect(t *testing.T, previous *detection.Harness, now time.Time) detection.Harness {
	t.Helper()
	found, ok := c.detector().Detect(context.Background(), "0.160.1", previous, now)
	if !ok {
		t.Fatal("Detect() found nothing, want a detection")
	}
	return found
}

var modelValues = []string{"gpt-6.1-sol", "gpt-6-luna", "gpt-reserve"}

func TestCodexProbesEachModelOfTheCatalogItRunsWithHiddenOnesIncludedAndDeclaresOnlyThoseThisLoginMayUse(t *testing.T) {
	codex := &aCodexCLI{live: &detection.Ran{Stdout: liveCatalog}, probes: map[string]string{"gpt-6.1-sol": "refused"}}

	found := codex.detect(t, nil, detectedNow)

	var want []detection.Command
	for _, slug := range []string{"gpt-6.1-sol", "gpt-6-luna", "gpt-5.5"} {
		want = append(want, detection.Command{Program: "codex", Args: []string{"exec", "--skip-git-repo-check", "-m", slug, "Reply OK"}, Dir: neutralFolder, Timeout: time.Minute})
	}
	if !reflect.DeepEqual(codex.probed, want) {
		t.Errorf("probes = %v, want %v", codex.probed, want)
	}
	if got := found.Options["model"].Names(); !slices.Equal(got, []string{"gpt-6-luna", "gpt-5.5"}) {
		t.Errorf("models = %v, want gpt-6-luna, gpt-5.5", got)
	}
}

func TestCodexsVersionIsReadFromVersion(t *testing.T) {
	codex := &aCodexCLI{}

	if version, ok := codex.detector().Version(context.Background()); version != "0.160.1" || !ok {
		t.Errorf("Version() = %q, %v, want 0.160.1", version, ok)
	}
}

func TestCodexDeclaresTheConfirmedModelsWithTheConfiguredModelAsTheDefaultAndNoEffort(t *testing.T) {
	codex := &aCodexCLI{config: "model = \"gpt-6-luna\"\nmodel_reasoning_effort = \"low\"\n"}

	found := codex.detect(t, nil, detectedNow)

	now := detection.Timestamp(detectedNow)
	model := detection.OptionOf(modelValues, "-m")
	model.Default = "gpt-6-luna"
	want := detection.Harness{Version: "0.160.1", DetectedAt: now, ConfirmedAt: &now, Options: map[string]config.Option{"model": model}}
	if !reflect.DeepEqual(found, want) {
		t.Errorf("Detect() = %+v, want %+v", found, want)
	}
}

func TestCodexsDefaultIsAConfirmedModelOnly(t *testing.T) {
	for name, at := range map[string]struct {
		codex *aCodexCLI
		want  string
	}{
		"the configured one refused: the first shown confirmed": {&aCodexCLI{config: "model = \"gpt-6.1-sol\"\n", probes: map[string]string{"gpt-6.1-sol": "refused"}}, "gpt-6-luna"},
		"only a hidden one confirmed: none":                     {&aCodexCLI{probes: map[string]string{"gpt-6.1-sol": "refused", "gpt-6-luna": "refused"}}, ""},
		"a configured one the catalog hides, once confirmed":    {&aCodexCLI{config: "model = \"gpt-reserve\"\n"}, "gpt-reserve"},
		"none configured: the first the catalog shows":          {&aCodexCLI{}, "gpt-6.1-sol"},
		"the model of a profile is not the top level's":         {&aCodexCLI{config: "[profiles.fast]\nmodel = \"gpt-6-luna\"\n"}, "gpt-6.1-sol"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := at.codex.detect(t, nil, detectedNow).Options["model"].Default; got != at.want {
				t.Errorf("default = %q, want %q", got, at.want)
			}
		})
	}
}

func TestAModelConfirmedBeforeAtTheSameVersionIsKeptWhenItsProbeNeitherConfirmsNorRefusesItAndOneRefusedNowIsDropped(t *testing.T) {
	now := detection.Timestamp(detectedNow)
	model := detection.OptionOf(modelValues, "-m")
	model.Default = "gpt-6.1-sol"
	previous := detection.Harness{Version: "0.160.1", DetectedAt: now, ConfirmedAt: &now, Options: map[string]config.Option{"model": model}}
	codex := &aCodexCLI{probes: map[string]string{"gpt-6.1-sol": "unknown", "gpt-6-luna": "refused", "gpt-reserve": "unknown"}}

	found := codex.detect(t, &previous, detectedNow.Add(18*time.Hour))

	if got := found.Options["model"]; !slices.Equal(got.Names(), []string{"gpt-6.1-sol", "gpt-reserve"}) || got.Default != "gpt-6.1-sol" {
		t.Errorf("model = %v default %s, want gpt-6.1-sol, gpt-reserve default gpt-6.1-sol", got.Names(), got.Default)
	}
	if found.ConfirmedAt == nil || *found.ConfirmedAt != now || found.DetectedAt != "2026-10-09T09:00:00.000Z" {
		t.Errorf("Detect() = %+v, want detected at 2026-10-09T09:00:00.000Z, confirmed at %s", found, now)
	}
}

func TestCodexDeclaresNoModelAndSaysWhyWhenNoProbeConfirmsOne(t *testing.T) {
	codex := &aCodexCLI{probes: map[string]string{"gpt-6.1-sol": "refused", "gpt-6-luna": "unknown", "gpt-reserve": "unknown"}}

	found := codex.detect(t, nil, detectedNow)

	want := detection.Harness{Version: "0.160.1", DetectedAt: detection.Timestamp(detectedNow), Options: map[string]config.Option{}, Problem: "Codex 0.160.1 confirmed none of its catalog's models for this login, so this machine declares no Codex model"}
	if !reflect.DeepEqual(found, want) {
		t.Errorf("Detect() = %+v, want %+v", found, want)
	}
}

func TestCodexGivesNothingToDetectWhenTheCatalogDoesNotComeOrListsNoModel(t *testing.T) {
	for name, catalog := range map[string]detection.Ran{"fails": {Status: 1, Stderr: "unknown command"}, "empty": {Stdout: `{"models":[]}`}} {
		t.Run(name, func(t *testing.T) {
			codex := &aCodexCLI{catalog: &catalog}

			if found, ok := codex.detector().Detect(context.Background(), "0.160.1", nil, detectedNow); ok {
				t.Errorf("Detect() = %+v, want nothing", found)
			}
		})
	}
}
