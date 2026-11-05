package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/commandline"
)

// A session started in plan mode could never leave it, since plan mode is disallowed as a whole (#465): where Claude Code's settings make plan the default mode and the flags name no mode of their own, the launch names one that asks before each action (#505, #507, #517).

const (
	permissionMode = "--permission-mode"
	planMode       = "plan"
	// manualMode asks before each action: Claude Code names it manual where its --help lists that, and default before (#517).
	manualMode  = "manual"
	defaultMode = "default"
	// skipPermissions runs every tool without asking.
	skipPermissions = "--dangerously-skip-permissions"
	settingsFlag    = "--settings"
	// whenPlanPerFolder is when the override applies where config check cannot know the folder.
	whenPlanPerFolder = "the Claude Code settings for the folder make plan the default mode"
)

// DefaultMode is the default permission mode the settings give a session: a mode they decide (none when they name none), or one each folder's settings decide.
type DefaultMode struct {
	IsPerFolder bool
	Mode        string
}

// modeIn is the default mode of settings text, or none when it is no JSON or names none: Claude Code reports broken settings itself.
func modeIn(text []byte) (string, bool) {
	var settings struct {
		Permissions struct {
			DefaultMode *string `json:"defaultMode"`
		} `json:"permissions"`
	}
	if json.Unmarshal(text, &settings) != nil || settings.Permissions.DefaultMode == nil {
		return "", false
	}
	return *settings.Permissions.DefaultMode, true
}

// modeInFile is a settings file's default mode, or none when the file is missing.
func modeInFile(path string) (string, bool) {
	text, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return modeIn(text)
}

// managedMode is the managed settings' default mode: managed-settings.json, then each visible `.json` in managed-settings.d in alphabetical order, the last that names one winning.
func managedMode(folder string) (string, bool) {
	dropIns := filepath.Join(folder, "managed-settings.d")
	files := []string{filepath.Join(folder, "managed-settings.json")}
	entries, _ := os.ReadDir(dropIns)
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") && !strings.HasPrefix(entry.Name(), ".") {
			files = append(files, filepath.Join(dropIns, entry.Name()))
		}
	}
	mode, found := "", false
	for _, file := range files {
		if each, ok := modeInFile(file); ok {
			mode, found = each, true
		}
	}
	return mode, found
}

// commandLineMode is the default mode `--settings` gives, a file or JSON; a relative file is the folder's, so without a folder it is unknown.
func commandLineMode(settings string, folder string) (string, bool) {
	switch {
	case strings.HasPrefix(strings.TrimLeft(settings, " \t\r\n"), "{"):
		return modeIn([]byte(settings))
	case filepath.IsAbs(settings):
		return modeInFile(settings)
	case folder != "":
		return modeInFile(filepath.Join(folder, settings))
	}
	return "", false
}

// DefaultModeOf is the default mode the managed settings folder, the user's settings file and the folder's own give a session started with the flags, in the folder or, with none, for config check.
func DefaultModeOf(managed string, user string, flags []string, folder string) DefaultMode {
	if mode, ok := managedMode(managed); ok {
		return DefaultMode{Mode: mode}
	}
	if settings, ok := valueOf(flags, settingsFlag); ok {
		if mode, ok := commandLineMode(settings, folder); ok {
			return DefaultMode{Mode: mode}
		}
	}
	for _, source := range sourcesOf(flags) {
		file := user
		if source != "user" {
			if folder == "" {
				return DefaultMode{IsPerFolder: true}
			}
			file = filepath.Join(folder, ".claude", map[string]string{"local": "settings.local.json", "project": "settings.json"}[source])
		}
		if mode, ok := modeInFile(file); ok {
			return DefaultMode{Mode: mode}
		}
	}
	return DefaultMode{}
}

// namesPermissionMode is whether the flags start Claude Code in a permission mode of their own, which wins over its settings' default mode.
func namesPermissionMode(flags []string) bool {
	return slices.ContainsFunc(flags, func(flag string) bool {
		return flag == permissionMode || strings.HasPrefix(flag, permissionMode+"=") || flag == skipPermissions
	})
}

// PlanOverride is `--permission-mode manual` (or `default` where the installed Claude Code lists no manual) where the settings' default mode is plan and the flags name none, with when it applies where that depends on the folder; no words otherwise.
func PlanOverride(flags []string, mode DefaultMode, permissionModes []string) commandline.Part {
	if namesPermissionMode(withoutPlanMode(flags)) || (!mode.IsPerFolder && mode.Mode != planMode) {
		return commandline.Part{}
	}
	chosen := defaultMode
	if slices.Contains(permissionModes, manualMode) {
		chosen = manualMode
	}
	part := commandline.Part{Words: []string{permissionMode, chosen}, Source: commandline.Adapter}
	if mode.IsPerFolder {
		part.When = whenPlanPerFolder
	}
	return part
}
