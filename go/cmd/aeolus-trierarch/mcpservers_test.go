package main

import (
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

func TestClaudeCodeOffersMCPServersOnTheHostAndInContainers(t *testing.T) {
	for name, configured := range map[string]*config.Runtime{"on the host": nil, "in containers": {Kind: "container"}} {
		if !harnessesThatAddMcpServers(configured)["claude-code"] {
			t.Errorf("Claude Code offers no MCP server %s, want every listed server", name)
		}
	}
}
