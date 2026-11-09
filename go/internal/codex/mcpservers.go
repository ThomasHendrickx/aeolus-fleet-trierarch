package codex

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Configured is what Codex's configuration names for a folder that would reach a session beside the servers its crew request names (#329).
type Configured struct {
	// McpServers are the user's and the project's servers, enabled or not.
	McpServers []string
	// Plugins are the ids of the plugins it enables, each of which may bring MCP servers of its own.
	Plugins []string
}

// ConfiguredFor is what Codex's configuration names for the folder, with the overrides as the app server's own flags over it, read through config/read (#329): it reads the configuration as Codex layers it and starts or reaches no server, where `codex mcp list` reaches every HTTP server it lists. A plugin's own servers are not in it, only the plugin.
func (a AppServer) ConfiguredFor(folder string, overrides []string) (Configured, error) {
	var configured Configured
	err := a.talkWith(overrides, func(c *conversation) error {
		read, err := c.ask("config/read", map[string]string{"cwd": folder})
		if err != nil {
			return err
		}
		var answer struct {
			Config *struct {
				McpServers map[string]json.RawMessage `json:"mcp_servers"`
				Plugins    map[string]struct {
					Enabled bool `json:"enabled"`
				} `json:"plugins"`
			} `json:"config"`
		}
		if err := json.Unmarshal(read, &answer); err != nil {
			return fmt.Errorf("config/read: %w", err)
		}
		if answer.Config == nil {
			return errors.New("config/read answered no configuration")
		}
		for name := range answer.Config.McpServers {
			configured.McpServers = append(configured.McpServers, name)
		}
		for id, plugin := range answer.Config.Plugins {
			if plugin.Enabled {
				configured.Plugins = append(configured.Plugins, id)
			}
		}
		return nil
	})
	return configured, err
}

// isTrierarchsPlugin is whether a session keeps the plugin: the aeolus-fleet plugin, whose hooks crew it.
func isTrierarchsPlugin(id string) bool { return strings.HasPrefix(id, aeolusPluginPrefix) }
