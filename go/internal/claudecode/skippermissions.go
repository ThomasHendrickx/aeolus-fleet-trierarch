package claudecode

import (
	"encoding/json"
	"os"
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
