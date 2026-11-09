package codex

import (
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
)

// McpList lists the MCP servers Codex loads in a folder through `codex mcp list --json` (#329): the user's, the project's and its plugins', as Codex itself reads its configuration, so the trierarch keeps no copy of how it does.
type McpList struct {
	// Program is the program to run, `codex` unless a test runs another.
	Program string
}

// McpServersIn are the names of the MCP servers Codex lists in the folder, each enabled or not.
func (l McpList) McpServersIn(folder string) ([]string, error) {
	command := exec.Command(l.Program, "mcp", "list", "--json")
	command.Dir = folder
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("codex mcp list in %s: %w", folder, err)
	}
	var listed []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(output, &listed); err != nil {
		return nil, fmt.Errorf("codex mcp list in %s: %w", folder, err)
	}
	names := make([]string, 0, len(listed))
	for _, server := range listed {
		if server.Name == "" {
			return nil, errors.New("codex mcp list in " + folder + " named a server without a name")
		}
		names = append(names, server.Name)
	}
	return names, nil
}
