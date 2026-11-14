package claudecode

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const (
	marketplace   = "aeolus-fleet"
	repository    = "ThomasHendrickx/aeolus-fleet-trierarch"
	pluginID      = "aeolus-fleet@aeolus-fleet"
	renamedPlugin = "aeolus@aeolus-fleet"
)

// PluginUpdate updates the aeolus-fleet plugin through Claude Code's own
// commands, from a release tag, as today's trierarch's upgrade does: the
// aeolus-fleet marketplace its settings declare is dropped from them (removing
// the marketplace would uninstall the plugin and delete its data, with its log),
// the marketplace is added again at the tag, updated, and the plugin updated,
// or installed where Claude Code lacks it; the renamed plugin goes.
type PluginUpdate struct {
	// Program is Claude Code's command, `claude` on the machine.
	Program string
	// Settings is Claude Code's settings.json: in CLAUDE_CONFIG_DIR when it is set, else in ~/.claude.
	Settings string
}

// PluginUpdateOf the user's home folder, and CLAUDE_CONFIG_DIR when it is not empty.
func PluginUpdateOf(homeDirectory string, configDirectory string) PluginUpdate {
	if configDirectory == "" {
		configDirectory = filepath.Join(homeDirectory, ".claude")
	}
	return PluginUpdate{Program: "claude", Settings: filepath.Join(configDirectory, "settings.json")}
}

// commandTimeout bounds each Claude Code command, which reaches the network.
const commandTimeout = 5 * time.Minute

func (p PluginUpdate) run(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, p.Program, args...)
	var stderr strings.Builder
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("claude %s failed: %s: %w", strings.Join(args, " "), strings.TrimSpace(string(output)+stderr.String()), err)
	}
	return string(output), nil
}

// Update installs the plugin of the release tag.
func (p PluginUpdate) Update(tag string) error {
	if err := p.dropDeclaredMarketplace(); err != nil {
		return err
	}
	if _, err := p.run("plugin", "marketplace", "add", repository+"#"+tag); err != nil {
		return err
	}
	if _, err := p.run("plugin", "marketplace", "update", marketplace); err != nil {
		return err
	}
	listed, err := p.run("plugin", "list", "--json")
	if err != nil {
		return err
	}
	var plugins []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(listed), &plugins); err != nil {
		return fmt.Errorf("claude plugin list --json said no list: %s", strings.TrimSpace(listed))
	}
	installed := make([]string, 0, len(plugins))
	for _, plugin := range plugins {
		installed = append(installed, plugin.ID)
	}
	// install of a plugin Claude Code has does not move it to the new version, and update of one it lacks fails.
	verb := "install"
	if slices.Contains(installed, pluginID) {
		verb = "update"
	}
	if _, err := p.run("plugin", verb, pluginID); err != nil {
		return err
	}
	if slices.Contains(installed, renamedPlugin) {
		_, err := p.run("plugin", "uninstall", renamedPlugin)
		return err
	}
	return nil
}

// dropDeclaredMarketplace drops the aeolus-fleet marketplace from the extraKnownMarketplaces of the settings, leaving everything else as it is: adding it again declares the new source.
func (p PluginUpdate) dropDeclaredMarketplace() error {
	if _, err := os.Stat(p.Settings); err != nil {
		return nil
	}
	settings, err := readObject(p.Settings)
	if err != nil {
		return err
	}
	declared, isObject := settings["extraKnownMarketplaces"].(map[string]any)
	if !isObject {
		return nil
	}
	if _, isDeclared := declared[marketplace]; !isDeclared {
		return nil
	}
	delete(declared, marketplace)
	return writeObject(p.Settings, settings)
}

// PluginVersion is the version the plugin's manifest at its root says, empty when it says none.
func PluginVersion(root string) string {
	text, err := os.ReadFile(filepath.Join(root, ".claude-plugin", "plugin.json"))
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
