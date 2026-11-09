package copilot

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
)

// McpList lists the MCP servers Copilot loads in a folder through `copilot mcp list --json` (#329): the user's, the workspace's and its plugins', as Copilot itself reads its configuration, so the trierarch keeps no copy of how it does.
type McpList struct {
	// Program is the program to run, `copilot` unless a test runs another.
	Program string
	// CopilotHome is the COPILOT_HOME its sessions get; empty when the trierarch has none.
	CopilotHome string
}

// McpServersIn are the names of the MCP servers Copilot lists in the folder, each enabled or not.
func (l McpList) McpServersIn(folder string) ([]string, error) {
	command := exec.Command(l.Program, "mcp", "list", "--json")
	command.Dir = folder
	if l.CopilotHome != "" {
		command.Env = append(os.Environ(), copilotHomeVariable+"="+l.CopilotHome)
	}
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("copilot mcp list in %s: %w", folder, err)
	}
	var listed struct {
		McpServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(output, &listed); err != nil {
		return nil, fmt.Errorf("copilot mcp list in %s: %w", folder, err)
	}
	names := make([]string, 0, len(listed.McpServers))
	for name := range listed.McpServers {
		names = append(names, name)
	}
	return names, nil
}
