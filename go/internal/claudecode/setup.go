// Package claudecode answers Claude Code's one-time questions ahead, so a
// session nobody watches never waits on one (docs/trierarch.md,
// "Unattended"): a trusted folder covers every folder under it, and a
// completed onboarding skips its first-run screens. The answers live in
// Claude Code's own `.claude.json`, changed key by key, keeping everything
// else and the file's mode. It follows CLAUDE_CONFIG_DIR as Claude Code does.
package claudecode

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// fullscreenOfferShownMax is how often Claude Code offers its fullscreen renderer at most: once seen this often, it offers it no more.
const fullscreenOfferShownMax = 3

// privateMode is the mode of a .claude.json init makes, as Claude Code keeps it.
const privateMode = 0o600

type Setup struct {
	// ClaudeJSON is .claude.json: in CLAUDE_CONFIG_DIR when it is set, else in the home folder.
	ClaudeJSON string
}

// Of the user's home folder, and CLAUDE_CONFIG_DIR when it is not empty.
func Of(homeDirectory string, configDirectory string) Setup {
	if configDirectory == "" {
		configDirectory = homeDirectory
	}
	return Setup{ClaudeJSON: filepath.Join(configDirectory, ".claude.json")}
}

func readObject(path string) (map[string]any, error) {
	text, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}, nil
	}
	var value map[string]any
	if err := json.Unmarshal(text, &value); err != nil || value == nil {
		return nil, fmt.Errorf("%s is no JSON object: fix it by hand, then run this again", path)
	}
	return value, nil
}

func writeObject(path string, value map[string]any) error {
	mode := os.FileMode(privateMode)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	text, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temporary := path + ".aeolus-trierarch.tmp"
	if err := os.WriteFile(temporary, append(text, '\n'), mode); err != nil {
		return err
	}
	if err := os.Chmod(temporary, mode); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func objectIn(value map[string]any, key string) map[string]any {
	if object, ok := value[key].(map[string]any); ok {
		return object
	}
	return map[string]any{}
}

// Trust accepts the trust question for the folder, and so for every folder under it.
func (s Setup) Trust(folder string) error {
	claude, err := readObject(s.ClaudeJSON)
	if err != nil {
		return err
	}
	projects := objectIn(claude, "projects")
	project := objectIn(projects, folder)
	project["hasTrustDialogAccepted"] = true
	projects[folder] = project
	claude["projects"] = projects
	return writeObject(s.ClaudeJSON, claude)
}

// CompleteOnboarding completes the onboarding and counts the fullscreen renderer offer as seen as often as Claude Code shows it.
func (s Setup) CompleteOnboarding() error {
	claude, err := readObject(s.ClaudeJSON)
	if err != nil {
		return err
	}
	seen, _ := claude["fullscreenUpsellSeenCount"].(float64)
	claude["hasCompletedOnboarding"] = true
	claude["fullscreenUpsellSeenCount"] = max(seen, fullscreenOfferShownMax)
	return writeObject(s.ClaudeJSON, claude)
}

// IsInstalled says whether `claude` runs on this machine.
func IsInstalled() bool {
	_, err := exec.LookPath("claude")
	return err == nil
}

// IsSignedIn says whether `claude auth status` reports a login.
func IsSignedIn() bool {
	return exec.Command("claude", "auth", "status").Run() == nil
}

// TrustedFolders are the folders whose trust question was accepted, from one read of .claude.json; none where there is no readable file.
func (s Setup) TrustedFolders() map[string]bool {
	trusted := map[string]bool{}
	claude, err := readObject(s.ClaudeJSON)
	if err != nil {
		return trusted
	}
	for folder, project := range objectIn(claude, "projects") {
		entry, isObject := project.(map[string]any)
		if !isObject {
			continue
		}
		if accepted, _ := entry["hasTrustDialogAccepted"].(bool); accepted {
			trusted[folder] = true
		}
	}
	return trusted
}
