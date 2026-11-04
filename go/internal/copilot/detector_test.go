package copilot

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

var detectedNow = time.Date(2026, 10, 29, 15, 0, 0, 0, time.UTC)

// helpConfig is `copilot help config` as Copilot CLI 1.0.105 prints it, cut to the settings around its model list.
const helpConfig = "Configuration Settings:\n\n" +
	"  `logLevel`: log level for CLI; defaults to \"default\". Set to \"all\" for debug logging.\n\n" +
	"  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.\n" +
	"    - \"claude-sonnet-5.5\"\n" +
	"    - \"claude-opus-5.5\"\n" +
	"    - \"gpt-6-luna\"\n" +
	"    - \"mai-code-1.1-flash\"\n\n" +
	"  `contextTier`: context window tier for tiered-pricing models (e.g., \"default\" or \"long_context\").\n" +
	"    - Can also be set with --context flag (overrides persisted setting)\n"

// aCopilotCLI is Copilot CLI 1.0.105: --version and help config as it prints them, or as given; every call is kept, and any other fails.
type aCopilotCLI struct {
	version    *detection.Ran
	helpConfig *detection.Ran
	settings   string
	calls      [][]string
}

func (c *aCopilotCLI) run(_ context.Context, command detection.Command) detection.Ran {
	c.calls = append(c.calls, command.Args)
	switch strings.Join(command.Args, " ") {
	case "--version":
		if c.version != nil {
			return *c.version
		}
		return detection.Ran{Stdout: "GitHub Copilot CLI 1.0.105.\nRun 'copilot update' to check for updates.\n"}
	case "help config":
		if c.helpConfig != nil {
			return *c.helpConfig
		}
		return detection.Ran{Stdout: helpConfig}
	}
	return detection.Ran{Status: 1, Stderr: "not a call detection makes"}
}

func (c *aCopilotCLI) detector() Detector {
	return Detector{Run: c.run, ReadSettings: func() string { return c.settings }}
}

func (c *aCopilotCLI) detect(t *testing.T) detection.Harness {
	t.Helper()
	found, ok := c.detector().Detect(context.Background(), "1.0.105", nil, detectedNow)
	if !ok {
		t.Fatal("Detect() found nothing, want a detection")
	}
	return found
}

func TestCopilotsVersionIsReadFromTheFirstLineVersionPrints(t *testing.T) {
	if version, ok := (&aCopilotCLI{}).detector().Version(context.Background()); version != "1.0.105" || !ok {
		t.Errorf("Version() = %q, %v, want 1.0.105", version, ok)
	}
}

func TestCopilotHasNoVersionWhenVersionFails(t *testing.T) {
	copilot := &aCopilotCLI{version: &detection.Ran{Status: 127, Stderr: "copilot: not found"}}

	if version, ok := copilot.detector().Version(context.Background()); ok {
		t.Errorf("Version() = %q, want none", version)
	}
}

func TestCopilotDeclaresEachModelItsHelpNamesAndAutoEachWithModel(t *testing.T) {
	found := (&aCopilotCLI{}).detect(t)

	want := []string{"claude-sonnet-5.5", "claude-opus-5.5", "gpt-6-luna", "mai-code-1.1-flash", "auto"}
	if got := found.Options["model"]; !slices.Equal(got.Names(), want) || !slices.Equal(got.Values["gpt-6-luna"], []string{"--model", "gpt-6-luna"}) {
		t.Errorf("model = %+v, want %v each with --model", got, want)
	}
}

func TestCopilotsDefaultIsTheModelItsSettingsNameWhenDeclaredElseAuto(t *testing.T) {
	for name, at := range map[string]struct{ settings, want string }{
		"no settings":                 {"", "auto"},
		"a model it declares":         {`{"model":"gpt-6-luna"}`, "gpt-6-luna"},
		"a model it does not declare": {`{"model":"gpt-retired"}`, "auto"},
		"settings that are no JSON":   {`{`, "auto"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := (&aCopilotCLI{settings: at.settings}).detect(t).Options["model"].Default; got != at.want {
				t.Errorf("default = %q, want %q", got, at.want)
			}
		})
	}
}

func TestCopilotConfirmsNoModelSoItRunsNoPrompt(t *testing.T) {
	copilot := &aCopilotCLI{}

	found := copilot.detect(t)

	if found.ConfirmedAt != nil || !reflect.DeepEqual(copilot.calls, [][]string{{"help", "config"}}) {
		t.Errorf("confirmed at %v after %v, want none after help config alone", found.ConfirmedAt, copilot.calls)
	}
}

func TestCopilotDeclaresAutoAloneAndSaysWhyWhenItsHelpNamesNoModel(t *testing.T) {
	copilot := &aCopilotCLI{helpConfig: &detection.Ran{Stdout: "Configuration Settings:\n"}}

	found := copilot.detect(t)

	model := detection.OptionOf([]string{"auto"}, "--model")
	model.Default = "auto"
	want := detection.Harness{Version: "1.0.105", DetectedAt: detection.Timestamp(detectedNow), Options: map[string]config.Option{"model": model}, Problem: "Copilot 1.0.105 names no model in copilot help config, so this machine declares auto only"}
	if !reflect.DeepEqual(found, want) {
		t.Errorf("Detect() = %+v, want %+v", found, want)
	}
}
