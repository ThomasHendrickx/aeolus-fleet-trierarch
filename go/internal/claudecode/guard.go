package claudecode

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
)

// The guard (aeolus-fleet docs/design/guard, section 4.6): every session starts with the ship's guard settings, one PreToolUse hook
// for every tool that runs guard check for the ship, passed with --settings.

const guardSettingsFile = "settings.json"

// GuardCommand is the hook's command: the trierarch's program, quoted for the shell the hook runs in, checking a call of the ship.
// Claude Code blocks a call only on exit code 2 and runs it on any other failure, so every failure of the program (killed, gone,
// exited with another code) exits 2: the guard fails closed.
func GuardCommand(program string, shipID string) string {
	return shellQuoted(program) + " guard check --ship " + shipID + " || exit 2"
}

// GuardSettings are the guard's settings for the ship: one PreToolUse hook, matcher *, running the command.
func GuardSettings(command string) ([]byte, error) {
	hook := map[string]any{"type": "command", "command": command}
	return json.Marshal(map[string]any{"hooks": map[string]any{"PreToolUse": []any{map[string]any{"matcher": "*", "hooks": []any{hook}}}}})
}

// writeGuardSettings writes the ship's guard settings in its guard folder, mode 600, and answers their file.
func (h Harness) writeGuardSettings(shipID string) (string, error) {
	if h.Ships == "" || h.Program == "" {
		return "", errors.New("claude-code has no guard: the trierarch's program or state folder is unknown")
	}
	text, err := GuardSettings(GuardCommand(h.Program, shipID))
	if err != nil {
		return "", fmt.Errorf("encode the guard settings: %w", err)
	}
	file := filepath.Join(guardfile.Folder(h.Ships, shipID), guardSettingsFile)
	if err := secrets.WritePrivate(file, text); err != nil {
		return "", fmt.Errorf("write the guard settings: %w", err)
	}
	return file, nil
}

// GuardProblem is why the entry's session cannot start guarded, "" when it can: the first settings file it would load that disables
// hooks, `disableAllHooks`, or in the managed settings `allowManagedHooksOnly`, which leaves the guard's hook out too. The request is
// given back with it (design 4.6).
func (h Harness) GuardProblem(entry reconciler.Entry) string {
	flags, err := h.Settings().LaunchFlags(entry.Options)
	if err != nil {
		return ""
	}
	for _, file := range managedFiles(h.Managed) {
		if disablesHooks(readSettings(file), true) {
			return guardDisabledBy(file)
		}
	}
	if settings, ok := valueOf(flags, settingsFlag); ok {
		text, file := commandLineSettings(settings, entry.Folder)
		if disablesHooks(text, false) {
			return guardDisabledBy(file)
		}
	}
	for _, source := range sourcesOf(flags) {
		file := h.userOf(entry)
		if source != "user" {
			file = filepath.Join(entry.Folder, ".claude", map[string]string{"local": "settings.local.json", "project": "settings.json"}[source])
		}
		if disablesHooks(readSettings(file), false) {
			return guardDisabledBy(file)
		}
	}
	return ""
}

func guardDisabledBy(file string) string { return "guard disabled by settings: " + file }

// readSettings is a settings file's text, none when it cannot be read.
func readSettings(file string) []byte {
	text, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	return text
}

// commandLineSettings are the text `--settings` gives, a file or JSON, and what names it: its file, a relative one the folder's.
func commandLineSettings(settings string, folder string) ([]byte, string) {
	if strings.HasPrefix(strings.TrimLeft(settings, " \t\r\n"), "{") {
		return []byte(settings), settingsFlag
	}
	if !filepath.IsAbs(settings) {
		settings = filepath.Join(folder, settings)
	}
	return readSettings(settings), settings
}

// disablesHooks is whether settings text turns hooks off, the managed settings' allowManagedHooksOnly too; text that is no JSON
// turns nothing off, as Claude Code reports broken settings itself.
func disablesHooks(text []byte, isManaged bool) bool {
	var settings struct {
		DisableAllHooks       bool `json:"disableAllHooks"`
		AllowManagedHooksOnly bool `json:"allowManagedHooksOnly"`
	}
	if text == nil || json.Unmarshal(text, &settings) != nil {
		return false
	}
	return settings.DisableAllHooks || (isManaged && settings.AllowManagedHooksOnly)
}

// shellQuoted is the word in single quotes, each of its own single quotes kept.
func shellQuoted(word string) string {
	return "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
}
