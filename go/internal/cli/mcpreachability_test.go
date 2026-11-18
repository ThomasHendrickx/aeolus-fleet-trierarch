package cli

import (
	"net"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpconfiguration"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

func TestStatusNamesAnUnreachableMCPServerWithItsReason(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	url := "http://" + listener.Addr().String() + "/mcp"
	listener.Close()
	at := paths.Of(machine.HomeDirectory, "")
	file := mcpconfiguration.File{Path: at.McpConfiguration}
	_, err = file.Apply(mcpconfiguration.Configuration{Identity: mcpconfiguration.Identity{FleetID: "fleet", PluginShipID: "plugin"}, Version: 1, PublicKey: "key", Servers: []mcpservers.Server{{Name: "graph", URL: url, Transport: mcpservers.Transport, Tools: []string{"read"}}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, words := range [][]string{{"status"}, {"status", "--json"}} {
		output, code := Main(words, machine)
		if code != 0 || !strings.Contains(output, "graph") || !strings.Contains(output, "connection refused") {
			t.Errorf("status %v = %s, %d, want graph and connection refused", words, output, code)
		}
	}
}
