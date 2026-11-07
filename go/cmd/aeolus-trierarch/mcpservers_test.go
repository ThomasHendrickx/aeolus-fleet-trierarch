package main

import (
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

func TestClaudeCodeOffersMCPServersOnTheHostAndInContainers(t *testing.T) {
	for name, configured := range map[string]*config.Runtime{"on the host": nil, "in containers": {Kind: "container"}} {
		adds, ok := harnessesThatAddMcpServers(configured)["claude-code"]
		if !ok || !adds("company-graph") || !adds("graph.v2") {
			t.Errorf("Claude Code offers no MCP server %s, want every listed server", name)
		}
	}
}

func TestCodexOffersMCPServersOnTheHostOnly(t *testing.T) {
	if adds, ok := harnessesThatAddMcpServers(nil)["codex"]; !ok || !adds("company-graph") {
		t.Error("Codex on the host offers no MCP server, want the listed servers it can add")
	}
	if _, ok := harnessesThatAddMcpServers(&config.Runtime{Kind: "container"})["codex"]; ok {
		t.Error("Codex in containers offers MCP servers, want none: Codex is not offered in containers")
	}
}
