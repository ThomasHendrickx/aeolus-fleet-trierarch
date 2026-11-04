package claudecode

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// ManagedSettings is where Claude Code reads its managed settings files on macOS and on Linux.
func ManagedSettings() string {
	if runtime.GOOS == "darwin" {
		return "/Library/Application Support/ClaudeCode"
	}
	return "/etc/claude-code"
}

// UserSettings is the user's settings file: in CLAUDE_CONFIG_DIR when it is not empty, else in ~/.claude.
func UserSettings(homeDirectory string, configDirectory string) string {
	if configDirectory == "" {
		configDirectory = filepath.Join(homeDirectory, ".claude")
	}
	return filepath.Join(configDirectory, "settings.json")
}

// keyVariables are the variables in a settings file's `env` that sign Claude Code in with something other than its subscription.
var keyVariables = []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"}

// settingSources are the settings files `--setting-sources` picks from, the one Claude Code takes first.
var settingSources = []string{"local", "project", "user"}

// Subscription is what Claude Code reads itself before a session on its subscription starts (api keys K6): its managed settings, `--settings` in the flags it would start with, and of the sources those flags load the folder's local and project settings and the user's.
type Subscription struct {
	Settings config.Harness
	// Managed is the folder of Claude Code's managed settings files.
	Managed string
	// User is the user's settings file.
	User string
}

// Problem is why a session with the options, in the folder, would reach a key on its subscription, naming what and where but never its value; empty when nothing puts one in reach.
func (s Subscription) Problem(options map[string]string, folder string) string {
	found := s.keyInReach(s.Settings.EffectiveFlags(options), folder)
	if found == "" {
		return ""
	}
	return fmt.Sprintf("claude-code would reach an API key on its subscription (%s): remove it, or run the ship on its API key", found)
}

// keyInReach is the first key the settings the flags load give, with where it is; empty when none does.
func (s Subscription) keyInReach(flags []string, folder string) string {
	files := []string{filepath.Join(s.Managed, "managed-settings.json")}
	dropIns := filepath.Join(s.Managed, "managed-settings.d")
	if entries, err := os.ReadDir(dropIns); err == nil {
		for _, entry := range entries {
			if name := entry.Name(); strings.HasSuffix(name, ".json") && !strings.HasPrefix(name, ".") {
				files = append(files, filepath.Join(dropIns, name))
			}
		}
	}
	if settings, ok := valueOf(flags, "--settings"); ok {
		if strings.HasPrefix(strings.TrimSpace(settings), "{") {
			if found := keyIn([]byte(settings)); found != "" {
				return found + " in --settings"
			}
		} else if filepath.IsAbs(settings) {
			files = append(files, settings)
		} else if folder != "" {
			files = append(files, filepath.Join(folder, settings))
		}
	}
	for _, source := range sourcesOf(flags) {
		switch {
		case source == "user":
			files = append(files, s.User)
		case folder == "":
			// A folder's own settings are unknown without its folder.
		case source == "local":
			files = append(files, filepath.Join(folder, ".claude", "settings.local.json"))
		case source == "project":
			files = append(files, filepath.Join(folder, ".claude", "settings.json"))
		}
	}
	for _, file := range files {
		text, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		if found := keyIn(text); found != "" {
			return found + " in " + file
		}
	}
	return ""
}

// valueOf is the last value the flags give the flag, as `--flag value` or `--flag=value`.
func valueOf(flags []string, flag string) (string, bool) {
	value, ok := "", false
	for at, word := range flags {
		if word == flag && at+1 < len(flags) {
			value, ok = flags[at+1], true
		} else if after, found := strings.CutPrefix(word, flag+"="); found {
			value, ok = after, true
		}
	}
	return value, ok
}

// sourcesOf are the settings sources Claude Code loads with the flags: none with `--restricted`, those `--setting-sources` names, else all.
func sourcesOf(flags []string) []string {
	if slices.Contains(flags, "--restricted") {
		return nil
	}
	named, ok := valueOf(flags, "--setting-sources")
	if !ok {
		return settingSources
	}
	var picked []string
	for _, word := range strings.Split(named, ",") {
		picked = append(picked, strings.TrimSpace(word))
	}
	var sources []string
	for _, source := range settingSources {
		if slices.Contains(picked, source) {
			sources = append(sources, source)
		}
	}
	return sources
}

// keyIn is what in settings text gives a key, named, never its value; empty for text that is no JSON object.
func keyIn(text []byte) string {
	var settings map[string]any
	if json.Unmarshal(text, &settings) != nil {
		return ""
	}
	if helper, ok := settings["apiKeyHelper"].(string); ok && helper != "" {
		return "apiKeyHelper"
	}
	env, _ := settings["env"].(map[string]any)
	for _, variable := range keyVariables {
		if value, ok := env[variable].(string); ok && value != "" {
			return variable
		}
	}
	return ""
}
