package main

import (
	"context"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpconfiguration"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
)

// mcpServersOffered checks the same machine route as the proxy before a report
// or crew: no harness offers a server that cannot answer from here (M4).
func mcpServersOffered(ctx context.Context, current mcpconfiguration.Configuration, harnesses []string, runtime *config.Runtime) map[string][]string {
	held := mcpservers.WithCredentialHeld(current.Servers, current.SecretNames())
	reachable, _ := (mcpservers.Checker{}).Check(ctx, held)
	return mcpservers.OfferedBy(reachable, harnesses, harnessesThatAddMcpServers(runtime))
}
