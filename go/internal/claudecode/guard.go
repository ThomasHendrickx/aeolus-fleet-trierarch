package claudecode

import (
	"context"
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

// GuardCommand is the hook's command: the trierarch's program, quoted for the shell the hook runs in, checking a call of the ship
// with the trierarch's configuration, none for the default one: the session's environment does not carry it. Claude Code blocks a
// call only on exit code 2 and runs it on any other failure, so every failure of the program (killed, gone, exited with another
// code) exits 2: the guard fails closed.
func GuardCommand(program string, shipID string, configuration string) string {
	command := shellQuoted(program) + " guard check --ship " + shipID
	if configuration != "" {
		command += " --config " + shellQuoted(configuration)
	}
	return command + " || exit 2"
}

// guardTimeout is the hook's timeout in seconds, above guard check's own 5-second deadline: Claude Code runs a call whose hook passes
// its timeout, so the guard must answer, and stop, first.
const guardTimeout = 30

// GuardSettings are the guard's settings for the ship: the configured settings, none when nil, with one PreToolUse hook added, matcher
// *, running the command. Claude Code takes only the last --settings, so the configured ones come with the guard's.
func GuardSettings(command string, configured map[string]any) ([]byte, error) {
	settings := map[string]any{}
	for key, value := range configured {
		settings[key] = value
	}
	hooks := map[string]any{}
	if configuredHooks, ok := settings["hooks"].(map[string]any); ok {
		for event, matchers := range configuredHooks {
			hooks[event] = matchers
		}
	} else if settings["hooks"] != nil {
		return nil, errors.New("the configured settings' hooks are no object")
	}
	preToolUse, ok := hooks["PreToolUse"].([]any)
	if !ok && hooks["PreToolUse"] != nil {
		return nil, errors.New("the configured settings' PreToolUse hooks are no list")
	}
	hook := map[string]any{"type": "command", "command": command, "timeout": guardTimeout}
	hooks["PreToolUse"] = append(append([]any{}, preToolUse...), map[string]any{"matcher": "*", "hooks": []any{hook}})
	settings["hooks"] = hooks
	return json.Marshal(settings)
}

// configuredSettings are the settings the configuration's --settings names, a file or JSON, none when it names none.
func configuredSettings(flags []string, folder string) (map[string]any, error) {
	named, ok := valueOf(flags, settingsFlag)
	if !ok {
		return nil, nil
	}
	text, file := commandLineSettings(named, folder)
	if text == nil {
		return nil, fmt.Errorf("the configured settings %s cannot be read", file)
	}
	var settings map[string]any
	if err := json.Unmarshal(text, &settings); err != nil || settings == nil {
		return nil, fmt.Errorf("the configured settings %s are no JSON object", file)
	}
	return settings, nil
}

// withoutSettingsFlag are the flags without --settings and its value: the guard's settings carry them.
func withoutSettingsFlag(flags []string) []string {
	kept := []string{}
	for at := 0; at < len(flags); at++ {
		switch {
		case flags[at] == settingsFlag && at+1 < len(flags):
			at++
		case strings.HasPrefix(flags[at], settingsFlag+"="):
		default:
			kept = append(kept, flags[at])
		}
	}
	return kept
}

// writeGuardSettings writes the ship's guard settings, with the configured ones, in its guard folder, mode 600, and answers their file.
func (h Harness) writeGuardSettings(shipID string, configured map[string]any) (string, error) {
	if h.Guards == "" || h.Program == "" {
		return "", errors.New("claude-code has no guard: the trierarch's program or state folder is unknown")
	}
	text, err := GuardSettings(GuardCommand(h.Program, shipID, h.Config), configured)
	if err != nil {
		return "", fmt.Errorf("make the guard settings: %w", err)
	}
	folder, err := guardfile.MakeFolder(h.Guards, shipID)
	if err != nil {
		return "", err
	}
	file := filepath.Join(folder, guardSettingsFile)
	if err := secrets.WritePrivate(file, text); err != nil {
		return "", fmt.Errorf("write the guard settings: %w", err)
	}
	return file, nil
}

// IsGuarded is whether its sessions start guarded: on the host. A session in a container cannot reach guard check on the host yet.
func (h Harness) IsGuarded() bool { return h.Homes == "" }

// GuardProblem is why the entry's session cannot start guarded, "" when it can: the first settings file it would load that disables
// hooks, `disableAllHooks`, or in the managed settings `allowManagedHooksOnly`, which leaves the guard's hook out too. The request is
// given back with it (design 4.6). Settings it cannot read within ctx are an error: the session does not start until they are read.
func (h Harness) GuardProblem(ctx context.Context, entry reconciler.Entry) (string, error) {
	flags, err := h.Settings().LaunchFlags(entry.Options)
	if err != nil {
		return "", nil
	}
	read := func(file string) ([]byte, error) { return readSettings(ctx, file) }
	for _, file := range managedFiles(h.Managed) {
		text, err := read(file)
		if err != nil {
			return "", err
		}
		if disablesHooks(text, true) {
			return guardDisabledBy(file), nil
		}
	}
	if settings, ok := valueOf(flags, settingsFlag); ok {
		text, file := commandLineSource(settings, entry.Folder)
		if text == nil {
			if text, err = read(file); err != nil {
				return "", err
			}
		}
		if disablesHooks(text, false) {
			return guardDisabledBy(file), nil
		}
	}
	for _, source := range sourcesOf(flags) {
		file := h.sessionUserOf(entry)
		if source != "user" {
			file = filepath.Join(entry.Folder, ".claude", map[string]string{"local": "settings.local.json", "project": "settings.json"}[source])
		}
		text, err := read(file)
		if err != nil {
			return "", err
		}
		if disablesHooks(text, false) {
			return guardDisabledBy(file), nil
		}
	}
	return "", nil
}

func guardDisabledBy(file string) string { return "guard disabled by settings: " + file }

// readSettings is a settings file's text, none when it cannot be read; an error only when ctx ends before it is read.
func readSettings(ctx context.Context, file string) ([]byte, error) {
	text, err := guardfile.Within(ctx, func() ([]byte, error) { return os.ReadFile(file) })
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, nil
	}
	return text, nil
}

// commandLineSettings are the text `--settings` gives, a file or JSON, and what names it: its file, a relative one the folder's.
func commandLineSettings(settings string, folder string) ([]byte, string) {
	text, file := commandLineSource(settings, folder)
	if text != nil {
		return text, file
	}
	read, err := os.ReadFile(file)
	if err != nil {
		return nil, file
	}
	return read, file
}

// commandLineSource is what `--settings` names: its JSON, named as the flag, or no text and its file, a relative one the folder's.
func commandLineSource(settings string, folder string) ([]byte, string) {
	if strings.HasPrefix(strings.TrimLeft(settings, " \t\r\n"), "{") {
		return []byte(settings), settingsFlag
	}
	if !filepath.IsAbs(settings) {
		settings = filepath.Join(folder, settings)
	}
	return nil, settings
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
