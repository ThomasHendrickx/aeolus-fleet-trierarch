package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/cli"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

func TestCodexIsRedetectedAndItsOldGuardProofDropsAfterAVersionChange(t *testing.T) {
	for _, when := range []string{"at startup", "while running"} {
		t.Run(when, func(t *testing.T) {
			var warnings []string
			detect := detectionWithProvenCodex(t, func(message string) { warnings = append(warnings, message) })
			t.Setenv("TEST_INSTALLED_CODEX", "0.160.1")
			if _, err := detect.Detect(t.Context(), []string{"codex"}, detection.ByStart); err != nil {
				t.Fatal(err)
			}
			if got := detect.Store.Load()["codex"]; got.Version != "0.160.1" || got.GuardProof != cli.Version ||
				!slices.Equal(got.Options[detection.ModelOption].Names(), []string{"old-model"}) {
				t.Fatalf("detection at the same version saved %+v, want the previous model and proof", got)
			}

			t.Setenv("TEST_INSTALLED_CODEX", "0.161.0")
			if when == "at startup" {
				if _, err := detect.Detect(t.Context(), []string{"codex"}, detection.ByStart); err != nil {
					t.Fatal(err)
				}
			} else {
				reported := make(chan struct{})
				detect.Given = func(detection.Detected) { close(reported) }
				confirmDue(detect, []string{"codex"})()
				select {
				case <-reported:
				case <-time.After(5 * time.Second):
					t.Fatal("the detection pass did not report the new Codex version")
				}
			}

			if got := detect.Store.Load()["codex"]; got.Version != "0.161.0" || got.GuardProof != "" ||
				!slices.Equal(got.Options[detection.ModelOption].Names(), []string{"current-model"}) {
				t.Fatalf("detection at the new version saved %+v, want the current model without the old proof", got)
			}
			if want := []string{"Codex 0.161.0 did not prove its guard"}; !slices.Equal(warnings, want) {
				t.Fatalf("detection warnings = %q, want %q", warnings, want)
			}
		})
	}
}

func detectionWithProvenCodex(t *testing.T, warn func(string)) detection.Detection {
	t.Helper()
	folder := t.TempDir()
	program := filepath.Join(folder, "codex")
	stub := `#!/bin/sh
case "$1" in
  --version) printf 'codex-cli %s\n' "$TEST_INSTALLED_CODEX" ;;
  debug) printf '%s\n' '{"models":[{"slug":"current-model","visibility":"list"}]}' ;;
  exec) printf 'OK\n' ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(program, []byte(stub), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", folder+string(os.PathListSeparator)+os.Getenv("PATH"))
	at := paths.Of(folder, "")
	store := detection.File{Path: at.Detected}
	if err := store.Save(detection.Detected{"codex": {
		Version: "0.160.1", GuardProof: cli.Version, DetectedAt: detection.Timestamp(time.Now()),
		Options: map[string]config.Option{detection.ModelOption: detection.OptionOf([]string{"old-model"}, "-m")},
	}}); err != nil {
		t.Fatal(err)
	}
	return detectionOf(at, nil, folder, filepath.Join(folder, "aeolus-trierarch"), warn)
}
