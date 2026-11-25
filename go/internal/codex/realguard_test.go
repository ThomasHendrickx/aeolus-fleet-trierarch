package codex

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestTheInstalledCodexProvesTheGuardWithItsOwnTools(t *testing.T) {
	if os.Getenv("AEOLUS_REAL_CODEX_GUARD") != "1" {
		t.Skip("set AEOLUS_REAL_CODEX_GUARD=1 to use a real Codex login in a temporary folder")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	program := filepath.Join(t.TempDir(), "aeolus-trierarch")
	build := exec.CommandContext(t.Context(), "go", "build", "-o", program, "../../cmd/aeolus-trierarch")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build trierarch: %v\n%s", err, output)
	}
	model := configuredModelOf(readConfigForProof(HomeOf(home, os.Getenv("CODEX_HOME"))))
	if model == "" {
		t.Fatal("the installed Codex has no configured model for the guard diagnostic")
	}
	proof := GuardProof{Program: program, Version: "test", CodexHome: HomeOf(home, os.Getenv("CODEX_HOME"))}
	if err := proof.Run(t.Context(), "codex", model); err != nil {
		t.Fatal(err)
	}
}

func readConfigForProof(home string) string {
	text, _ := os.ReadFile(filepath.Join(home, "config.toml"))
	return string(text)
}
