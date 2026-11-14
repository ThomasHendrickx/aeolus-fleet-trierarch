package copilot

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	marketplaceName       = "aeolus-fleet"
	marketplaceRepository = "ThomasHendrickx/aeolus-fleet-trierarch"
	pluginID              = "aeolus-fleet@aeolus-fleet"
	// commandTimeout bounds each Copilot command, which reaches the network.
	commandTimeout = 5 * time.Minute
)

// PluginInstall installs the aeolus-fleet plugin through Copilot's own commands. Copilot's marketplace add takes no ref, so the tag cannot be pinned: the plugin installed is checked against the tag after it, and a plugin at another version is an error.
type PluginInstall struct {
	// Program is Copilot's command, `copilot` on the machine.
	Program string
	// Home is COPILOT_HOME when the trierarch has one; empty otherwise.
	Home string
	// Version is the version of the aeolus-fleet plugin installed now, empty when there is none.
	Version func() string
}

func (p PluginInstall) run(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, p.Program, args...)
	if p.Home != "" {
		command.Env = append(os.Environ(), copilotHomeVariable+"="+p.Home)
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("copilot %s failed: %s: %w", strings.Join(args, " "), strings.TrimSpace(string(output)), err)
	}
	return string(output), nil
}

// Install adds the aeolus-fleet marketplace where Copilot lacks it, installs the plugin, and checks it is at the tag.
func (p PluginInstall) Install(tag string) error {
	listed, err := p.run("plugin", "marketplace", "list")
	if err != nil {
		return err
	}
	if !strings.Contains(listed, marketplaceName) {
		if _, err := p.run("plugin", "marketplace", "add", marketplaceRepository); err != nil {
			return err
		}
	}
	if _, err := p.run("plugin", "install", pluginID); err != nil {
		return err
	}
	if installed := p.Version(); installed != strings.TrimPrefix(tag, "v") {
		return fmt.Errorf("the aeolus-fleet plugin Copilot installed is at version %q, not at the tag %s, and its marketplace takes no tag", installed, tag)
	}
	return nil
}
