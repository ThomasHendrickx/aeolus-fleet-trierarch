package copilot

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// PluginVersion is the version the aeolus-fleet plugin's manifest at its root says, empty when it says none.
func PluginVersion(root string) string {
	text, err := os.ReadFile(filepath.Join(root, ".github", "plugin", "plugin.json"))
	if err != nil {
		return ""
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(text, &manifest) != nil {
		return ""
	}
	return manifest.Version
}
