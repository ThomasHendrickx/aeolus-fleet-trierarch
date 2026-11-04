package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(text, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestTrustsAFolderKeepingEverythingElseAndTheFilesMode(t *testing.T) {
	home := t.TempDir()
	claudeJSON := filepath.Join(home, ".claude.json")
	if err := os.WriteFile(claudeJSON, []byte(`{"userID":"u","projects":{"/elsewhere":{"allowedTools":["Bash"]},"/work":{"history":[]}}}`), 0o640); err != nil {
		t.Fatal(err)
	}
	setup := Of(home, "")

	if err := setup.Trust("/work"); err != nil {
		t.Fatal(err)
	}

	want := map[string]any{"userID": "u", "projects": map[string]any{"/elsewhere": map[string]any{"allowedTools": []any{"Bash"}}, "/work": map[string]any{"history": []any{}, "hasTrustDialogAccepted": true}}}
	if got := readJSON(t, claudeJSON); !reflect.DeepEqual(got, want) {
		t.Errorf("wrote %v, want %v", got, want)
	}
	if info, _ := os.Stat(claudeJSON); info.Mode().Perm() != 0o640 {
		t.Errorf("mode %o, want 640", info.Mode().Perm())
	}
}

func TestCompletesTheOnboardingInAFileOnlyItsUserReads(t *testing.T) {
	home := t.TempDir()
	setup := Of(home, "")

	if err := setup.CompleteOnboarding(); err != nil {
		t.Fatal(err)
	}

	claudeJSON := filepath.Join(home, ".claude.json")
	want := map[string]any{"hasCompletedOnboarding": true, "fullscreenUpsellSeenCount": float64(3)}
	if got := readJSON(t, claudeJSON); !reflect.DeepEqual(got, want) {
		t.Errorf("wrote %v, want %v", got, want)
	}
	if info, _ := os.Stat(claudeJSON); info.Mode().Perm() != 0o600 {
		t.Errorf("mode %o, want 600", info.Mode().Perm())
	}
}

func TestKeepsAFullscreenOfferSeenMoreOften(t *testing.T) {
	home := t.TempDir()
	claudeJSON := filepath.Join(home, ".claude.json")
	if err := os.WriteFile(claudeJSON, []byte(`{"fullscreenUpsellSeenCount":5}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := Of(home, "").CompleteOnboarding(); err != nil {
		t.Fatal(err)
	}

	if got := readJSON(t, claudeJSON)["fullscreenUpsellSeenCount"]; got != float64(5) {
		t.Errorf("seen %v, want 5", got)
	}
}

func TestFollowsClaudeConfigDir(t *testing.T) {
	home := t.TempDir()
	configDirectory := filepath.Join(home, "elsewhere")

	if err := Of(home, configDirectory).Trust("/work"); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(configDirectory, ".claude.json")); err != nil {
		t.Errorf("no .claude.json in CLAUDE_CONFIG_DIR: %v", err)
	}
}

func TestRefusesAClaudeJSONThatIsNoObject(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`[`), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := Of(home, "").Trust("/work"); err == nil {
		t.Error("wrote over a .claude.json that is no JSON object")
	}
}

// onPath puts a `claude` that answers `auth status` with the exit status given first on the PATH.
func onPath(t *testing.T, authStatus int) {
	t.Helper()
	bin := t.TempDir()
	script := "#!/bin/sh\n[ \"$1 $2\" = 'auth status' ] && exit " + string(rune('0'+authStatus)) + "\nexit 2\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
}

func TestSaysWhetherClaudeCodeIsInstalledAndSignedIn(t *testing.T) {
	onPath(t, 0)

	if !IsInstalled() || !IsSignedIn() {
		t.Errorf("installed %v, signed in %v, want both", IsInstalled(), IsSignedIn())
	}
}

func TestSaysClaudeCodeIsNotSignedInWhenItsAuthStatusFails(t *testing.T) {
	onPath(t, 1)

	if !IsInstalled() || IsSignedIn() {
		t.Errorf("installed %v, signed in %v, want installed only", IsInstalled(), IsSignedIn())
	}
}

func TestSaysClaudeCodeIsNotInstalledWhereNoClaudeRuns(t *testing.T) {
	t.Setenv("PATH", t.TempDir())

	if IsInstalled() {
		t.Error("installed with no claude on the PATH")
	}
}
