package claudecode

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// IsSkipPermissionsAccepted says whether the user's settings file accepts bypass permissions mode, the one-time question `--dangerously-skip-permissions` asks (#403); not when the file is missing or no JSON.
func IsSkipPermissionsAccepted(userSettings string) bool {
	text, err := os.ReadFile(userSettings)
	if err != nil {
		return false
	}
	var settings struct {
		Accepted bool `json:"skipDangerousModePermissionPrompt"`
	}
	return json.Unmarshal(text, &settings) == nil && settings.Accepted
}

// SkipPermissions keeps bypass permissions mode accepted once the operator
// accepted it: a plugin install that rewrote the user settings dropped the
// acceptance, and every new launch was given back (#393). Only the operator
// accepts it; the trierarch remembers that it saw the acceptance, and writes
// it again, keeping all else the settings hold, where the key is gone and the
// configuration launches with `--dangerously-skip-permissions`. A key the
// operator set to false, or settings that are no JSON, are left alone.
type SkipPermissions struct {
	// Settings is Claude Code's user settings file.
	Settings string
	// Seen is the trierarch's own file that says it saw the acceptance in Settings.
	Seen string
}

// Keep says whether the settings accept bypass permissions mode, after writing the acceptance again where it is kept.
func (s SkipPermissions) Keep(harness config.Harness) bool {
	if IsSkipPermissionsAccepted(s.Settings) {
		if _, err := os.Stat(s.Seen); errors.Is(err, os.ErrNotExist) {
			_ = os.MkdirAll(filepath.Dir(s.Seen), 0o700)
			_ = os.WriteFile(s.Seen, nil, 0o600)
		}
		return true
	}
	if _, err := os.Stat(s.Seen); err != nil || !launchesWithSkipPermissions(harness) || !isAcceptanceGone(s.Settings) {
		return false
	}
	return AcceptSkipPermissions(s.Settings) == nil
}

// isAcceptanceGone says whether the settings name no acceptance at all: missing, or a JSON object without the key.
func isAcceptanceGone(settings string) bool {
	text, err := os.ReadFile(settings)
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	var values map[string]json.RawMessage
	if err != nil || json.Unmarshal(text, &values) != nil || values == nil {
		return false
	}
	_, isNamed := values[skipPermissionsAccepted]
	return !isNamed
}

// launchesWithSkipPermissions says whether the flags, or a value of an option, hold `--dangerously-skip-permissions`.
func launchesWithSkipPermissions(harness config.Harness) bool {
	if slices.Contains(harness.Flags, skipPermissions) {
		return true
	}
	for _, option := range harness.Options {
		for _, flags := range option.Values {
			if slices.Contains(flags, skipPermissions) {
				return true
			}
		}
	}
	return false
}
