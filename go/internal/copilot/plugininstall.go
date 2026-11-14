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

// PluginInstall installs the aeolus-fleet plugin through Copilot's own commands, its marketplace at the tag given.
type PluginInstall struct {
	// Program is Copilot's command, `copilot` on the machine.
	Program string
	// Home is COPILOT_HOME when the trierarch has one; empty otherwise.
	Home string
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

// Install adds the aeolus-fleet marketplace at the tag and installs the plugin from it. Copilot lists no marketplace's ref and refuses to add one it has, so one it has is removed first, with the plugin installed from it.
func (p PluginInstall) Install(tag string) error {
	listed, err := p.run("plugin", "marketplace", "list")
	if err != nil {
		return err
	}
	if strings.Contains(listed, marketplaceName) {
		if _, err := p.run("plugin", "marketplace", "remove", "--force", marketplaceName); err != nil {
			return err
		}
	}
	if _, err := p.run("plugin", "marketplace", "add", marketplaceRepository+"#"+tag); err != nil {
		return err
	}
	_, err = p.run("plugin", "install", pluginID)
	return err
}
