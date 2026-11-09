package copilot

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// listTimeout is how long `copilot mcp list` may take before the start gives up on it, so a hung listing holds up neither the start nor the run pass.
const listTimeout = 30 * time.Second

// listWaitDelay is how long a listing ended for its time may keep its output open, by a child of its own, before the listing returns anyway.
const listWaitDelay = time.Second

// McpList lists the MCP servers Copilot loads in a folder through `copilot mcp list --json` (#329): the user's, the workspace's and its plugins', as Copilot itself reads its configuration, so the trierarch keeps no copy of how it does.
type McpList struct {
	// Program is the program to run, `copilot` unless a test runs another.
	Program string
	// CopilotHome is the COPILOT_HOME its sessions get; empty when the trierarch has none.
	CopilotHome string
	// Timeout is how long a listing may take; listTimeout when zero.
	Timeout time.Duration
}

// McpServersIn are the names of the MCP servers Copilot lists in the folder, each enabled or not; an error once the listing outlasts its time or the context ends.
func (l McpList) McpServersIn(ctx context.Context, folder string) ([]string, error) {
	timeout := l.Timeout
	if timeout == 0 {
		timeout = listTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(ctx, l.Program, "mcp", "list", "--json")
	command.WaitDelay = listWaitDelay
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
