package claudecode

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
)

// The guard (aeolus-fleet docs/design/guard, section 4.6): every session starts with the ship's guard settings, one PreToolUse hook
// for every tool that runs guard check for the ship, passed with --settings.

const guardSettingsFile = "settings.json"

// GuardCommand is the hook's command: the trierarch's program, quoted for the shell the hook runs in, checking a call of the ship.
func GuardCommand(program string, shipID string) string {
	return shellQuoted(program) + " guard check --ship " + shipID
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

// shellQuoted is the word in single quotes, each of its own single quotes kept.
func shellQuoted(word string) string {
	return "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
}
