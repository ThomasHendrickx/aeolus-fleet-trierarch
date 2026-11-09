package codex

import (
	"encoding/json"
	"errors"
	"fmt"
)

// McpServersIn are the names of the MCP servers Codex's configuration names for the folder, the user's and the project's, enabled or not, read through config/read (#329): it reads the configuration as Codex layers it and starts or reaches no server, where `codex mcp list` reaches every HTTP server it lists. A plugin's own servers are not in it.
func (a AppServer) McpServersIn(folder string) ([]string, error) {
	var names []string
	err := a.talk(func(c *conversation) error {
		read, err := c.ask("config/read", map[string]string{"cwd": folder})
		if err != nil {
			return err
		}
		var answer struct {
			Config *struct {
				McpServers map[string]json.RawMessage `json:"mcp_servers"`
			} `json:"config"`
		}
		if err := json.Unmarshal(read, &answer); err != nil {
			return fmt.Errorf("config/read: %w", err)
		}
		if answer.Config == nil {
			return errors.New("config/read answered no configuration")
		}
		for name := range answer.Config.McpServers {
			names = append(names, name)
		}
		return nil
	})
	return names, err
}
