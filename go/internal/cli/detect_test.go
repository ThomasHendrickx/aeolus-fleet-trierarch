package cli

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

const detectedAt = "2026-11-04T10:00:00.000Z"

// someDetection finds Claude Code 2.1.306 with two models, and keeps what each detection was asked.
type someDetection struct {
	asked []string
}

func (d *someDetection) detect(_ paths.Paths, harnesses []string, by detection.By) (detection.Detected, error) {
	d.asked = append(d.asked, string(by)+" "+strings.Join(harnesses, ","))
	confirmed := detectedAt
	return detection.Detected{"claude-code": {Version: "2.1.306", DetectedAt: detectedAt, ConfirmedAt: &confirmed, Options: map[string]config.Option{"model": detection.OptionOf([]string{"claude-sonnet-5", "claude-opus-5"}, "--model")}}}, nil
}

func TestDetectDetectsEveryConfiguredHarnessByHandAndGivesWhatItFound(t *testing.T) {
	machine, _, _ := aMain(t)
	found := &someDetection{}
	machine.Detect = found.detect
	Main(setupWords(), machine)

	output, code := Main([]string{"detect", "--json"}, machine)

	confirmed := detectedAt
	want := map[string]any{"harnesses": map[string]any{"claude-code": map[string]any{"version": "2.1.306", "confirmedAt": confirmed, "options": map[string]any{"model": []any{"claude-sonnet-5", "claude-opus-5"}}}}}
	if got := decoded(t, output); code != 0 || !reflect.DeepEqual(got, want) {
		t.Errorf("detect answered %v, %d, want %v", got, code, want)
	}
	if !slices.Contains(found.asked, "hand claude-code") {
		t.Errorf("detection asked %v, want claude-code by hand", found.asked)
	}
}

func TestDetectSaysALinePerHarness(t *testing.T) {
	machine, _, _ := aMain(t)
	machine.Detect = (&someDetection{}).detect
	Main(setupWords(), machine)

	output, code := Main([]string{"detect"}, machine)

	if want := "claude-code 2.1.306: model claude-sonnet-5, claude-opus-5; models confirmed " + detectedAt; code != 0 || output != want {
		t.Errorf("detect said %q, %d, want %q", output, code, want)
	}
}

func TestInitSaysWhatEachHarnessOffersAsDetectedOncePerHarnessVersion(t *testing.T) {
	machine, _, _ := aMain(t)
	found := &someDetection{}
	machine.Detect = found.detect

	output, code := Main(setupWords(), machine)

	if want := "claude-code 2.1.306: model claude-sonnet-5, claude-opus-5; models confirmed " + detectedAt; code != 0 || !strings.Contains(output, want) {
		t.Errorf("init said %q, %d, want a line %q", output, code, want)
	}
	if !slices.Equal(found.asked, []string{"start claude-code"}) {
		t.Errorf("detection asked %v, want claude-code at start", found.asked)
	}
}

func TestConfigCheckRefusesAConfigurationThatSetsAModelOption(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	file := filepath.Join(machine.HomeDirectory, ".aeolus", "trierarch", "config.json")
	if err := os.WriteFile(file, []byte(`{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{"claude-code":{"flags":[],"options":{"model":{"values":{"opus":["--model","opus"]}}}}}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	output, code := Main([]string{"config", "check"}, machine)

	if want := "The configuration at " + file + " sets a model option for claude-code: model ids come from detection only (#382), so remove it; aeolus-trierarch detect lists them"; code != 1 || output != want {
		t.Errorf("config check said %q, %d, want %q", output, code, want)
	}
}
