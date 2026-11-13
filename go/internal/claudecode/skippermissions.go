package claudecode

import (
	"encoding/json"
	"os"
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

// KeepSkipPermissionsAccepted accepts bypass permissions mode in the user's
// settings file, keeping all else it holds, where the harness's configuration
// launches with `--dangerously-skip-permissions`, in its flags or an option,
// and says whether the file accepts it. The flag the operator configured is
// the consent, so neither a plugin install that rewrote the settings without
// the acceptance nor one never recorded hands a ship back (#393). Settings
// that are no JSON are left alone.
func KeepSkipPermissionsAccepted(userSettings string, harness config.Harness) bool {
	if IsSkipPermissionsAccepted(userSettings) {
		return true
	}
	if !launchesWithSkipPermissions(harness) {
		return false
	}
	return AcceptSkipPermissions(userSettings) == nil
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
