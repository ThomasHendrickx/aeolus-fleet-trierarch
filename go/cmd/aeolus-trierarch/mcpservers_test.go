package main

import (
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/copilot"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/modelproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
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

func TestCopilotOffersMCPServersOnTheHost(t *testing.T) {
	if adds, ok := harnessesThatAddMcpServers(nil)["copilot"]; !ok || !adds("company-graph") || !adds("graph.v2") {
		t.Error("Copilot offers no MCP server on the host, want every listed server")
	}
}

func TestCopilotOffersNoMCPServerInContainers(t *testing.T) {
	if _, ok := harnessesThatAddMcpServers(&config.Runtime{Kind: "container"})["copilot"]; ok {
		t.Error("Copilot in containers offers MCP servers, want none: Copilot is not offered in containers")
	}
}

func TestCopilotIsWiredWithTheMCPProxyAndTheSessionsFolderItsMCPServersNeed(t *testing.T) {
	configuration := config.Configuration{Harnesses: map[string]config.Harness{"copilot": {}}}
	at := paths.Paths{Sessions: t.TempDir()}
	wired, _, err := harnessesOf(configuration, at, map[string]string{}, t.TempDir(), &startedSessions{}, modelproxy.Runtime{Folder: t.TempDir()}, &offers{configured: configuration})
	if err != nil {
		t.Fatal(err)
	}
	harness, ok := wired["copilot"].(copilot.Harness)
	if !ok {
		t.Fatalf("copilot is wired as %T, want copilot.Harness", wired["copilot"])
	}
	if harness.ProxyURL == nil {
		t.Error("copilot has no ProxyURL: a session crewed with MCP servers never starts")
	}
	if harness.Sessions != at.Sessions {
		t.Errorf("copilot Sessions = %q, want %q", harness.Sessions, at.Sessions)
	}
}
