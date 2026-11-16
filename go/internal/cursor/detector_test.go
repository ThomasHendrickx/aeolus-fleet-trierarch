package cursor

import (
	"context"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
)

func TestCursorDetectionUsesTheCapturedBuildAndModelsWithoutAPrompt(t *testing.T) {
	models, err := os.ReadFile("../../../packages/trierarch/test/logs/cursor-models.txt")
	if err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	d := Detector{Run: func(_ context.Context, command detection.Command) detection.Ran {
		if command.Program != "agent" {
			t.Errorf("program = %q, want agent", command.Program)
		}
		calls = append(calls, command.Args)
		if command.Args[0] == "--version" {
			return detection.Ran{Stdout: "2026.11.13-eacade1\n"}
		}
		return detection.Ran{Stdout: string(models)}
	}}
	if version, ok := d.Version(context.Background()); !ok || version != "2026.11.13-eacade1" {
		t.Errorf("Version() = %q, %v", version, ok)
	}
	found, ok := d.Detect(context.Background(), "2026.11.13-eacade1", nil, time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC))
	if !ok || found.Options["model"].Default != "auto" || found.ConfirmedAt != "" {
		t.Errorf("Detect() = %+v, %v, want auto without confirmation", found, ok)
	}
	for _, id := range []string{"auto", "gpt-5.3-codex"} {
		if got := found.Options["model"].Values[id]; !reflect.DeepEqual(got, []string{"--model", id}) {
			t.Errorf("model %s = %v", id, got)
		}
	}
	if !reflect.DeepEqual(calls, [][]string{{"--version"}, {"models"}}) {
		t.Errorf("calls = %v, want version and models only", calls)
	}
}

func TestCursorDetectionHandlesMissingCLIAndUnavailableModels(t *testing.T) {
	d := Detector{Run: func(context.Context, detection.Command) detection.Ran { return detection.Ran{Status: 127} }}
	if _, ok := d.Version(context.Background()); ok {
		t.Error("Version() reports a missing CLI")
	}
	found, _ := d.Detect(context.Background(), "2026.11.13-eacade1", nil, time.Now())
	if got := found.Options["model"].Names(); !reflect.DeepEqual(got, []string{"auto"}) || found.Problem == "" {
		t.Errorf("Detect() = %+v, want auto and a problem", found)
	}
}

func TestCursorDetectionUsesTheListedDefaultAndIgnoresMalformedIDs(t *testing.T) {
	d := Detector{Run: func(context.Context, detection.Command) detection.Ran {
		return detection.Ran{Stdout: "Available models\n\nauto - Auto\nsonnet - Sonnet (default)\nbad name - Bad\n"}
	}}
	found, _ := d.Detect(context.Background(), "2026.11.13-eacade1", nil, time.Now())
	if got := found.Options["model"]; got.Default != "sonnet" || !reflect.DeepEqual(got.Names(), []string{"auto", "sonnet"}) {
		t.Errorf("models = %+v", got)
	}
}
