package codex

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
)

func TestCodexDetectionKeepsGuardProofOnlyForTheInstalledVersion(t *testing.T) {
	const detectedVersion, trierarchVersion = "0.160.1", "0.46.0"
	for _, example := range []struct {
		name, installed, previousProof, wantProof string
		hasLogin, wantsWarning                    bool
	}{
		{name: "proof succeeded", installed: detectedVersion, hasLogin: true, wantProof: trierarchVersion},
		{name: "Codex changed during the probe", installed: "0.161.0", hasLogin: true},
		{name: "probe failed", installed: detectedVersion, wantsWarning: true},
		{name: "previous proof still applies", installed: detectedVersion, previousProof: trierarchVersion, wantProof: trierarchVersion},
	} {
		t.Run(example.name, func(t *testing.T) {
			folder := t.TempDir()
			program := filepath.Join(folder, "codex")
			fake, err := os.ReadFile("testdata/guard-proof-codex.sh")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(program, fake, 0o700); err != nil {
				t.Fatal(err)
			}
			if example.hasLogin {
				if err := os.WriteFile(filepath.Join(folder, "auth.json"), []byte("{}"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			stub := &aCodexCLI{}
			detector := stub.detector()
			detector.Run = func(ctx context.Context, command detection.Command) detection.Ran {
				if slices.Equal(command.Args, []string{"--version"}) {
					return detection.Ran{Stdout: "codex-cli " + example.installed + "\n"}
				}
				return stub.run(ctx, command)
			}
			detector.Program = program
			detector.NeutralFolder = func() (string, error) { return t.TempDir(), nil }
			detector.GuardProof = GuardProof{Program: filepath.Join(folder, "aeolus-trierarch"), Version: trierarchVersion, CodexHome: folder}
			var warnings []string
			detector.Warn = func(message string) { warnings = append(warnings, message) }

			previous := &detection.Harness{Version: detectedVersion, GuardProof: example.previousProof}
			found, ok := detector.Detect(t.Context(), detectedVersion, previous, detectedNow)
			if !ok || found.GuardProof != example.wantProof {
				t.Fatalf("guard proof = %q, detected = %t, warnings = %q, want proof %q", found.GuardProof, ok, warnings, example.wantProof)
			}
			if !slices.Equal(found.Options[detection.ModelOption].Names(), modelValues) {
				t.Fatalf("offered models = %v, want %v", found.Options[detection.ModelOption].Names(), modelValues)
			}
			var wantWarnings []string
			if example.wantsWarning {
				wantWarnings = []string{"Codex 0.160.1 did not prove its guard"}
			}
			if !slices.Equal(warnings, wantWarnings) {
				t.Fatalf("detection warnings = %q, want %q", warnings, wantWarnings)
			}
		})
	}
}

func TestCodexNeedsDetectionWhenConfiguredGuardProofIsMissingOrStale(t *testing.T) {
	for _, example := range []struct {
		name, program, proof string
		want                 bool
	}{
		{name: "no guard diagnostic configured"},
		{name: "missing proof", program: "/trierarch", want: true},
		{name: "old proof", program: "/trierarch", proof: "0.45.0", want: true},
		{name: "current proof", program: "/trierarch", proof: "0.46.0"},
	} {
		t.Run(example.name, func(t *testing.T) {
			detector := Detector{GuardProof: GuardProof{Program: example.program, Version: "0.46.0"}}
			if got := detector.NeedsDetection(detection.Harness{GuardProof: example.proof}); got != example.want {
				t.Fatalf("NeedsDetection(proof=%q) = %t, want %t", example.proof, got, example.want)
			}
		})
	}
}
