package main

import (
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/aip"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/container"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

func TestEverySessionOnTheHostAndInContainersReachesTheConfiguredAipServerWithTheSecretNamed(t *testing.T) {
	at := paths.Of(t.TempDir(), "")
	own := &config.Aip{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}

	onTheHost := sessionRuntime(at, "aeolus-trierarch", config.Configuration{Aip: own})
	inContainers := sessionRuntime(at, "aeolus-trierarch", config.Configuration{Aip: own, Runtime: &config.Runtime{Kind: "container", Binary: "podman"}})

	for runtime, held := range map[string]*sessions.Aip{"on the host": onTheHost.(sessions.Runtime).Aip, "in containers": inContainers.(container.Runtime).Holds.Aip} {
		if held == nil || held.Configured == nil || *held.Configured != (aip.Setting{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}) || held.Secrets == nil {
			t.Errorf("%s the sessions reach aip %+v, want the configured server and the secret aip-read", runtime, held)
		}
	}
}

func TestNoSessionReachesAnAipServerTheConfigurationDoesNotName(t *testing.T) {
	if held := sessionRuntime(paths.Of(t.TempDir(), ""), "aeolus-trierarch", config.Configuration{}).(sessions.Runtime).Aip; held != nil {
		t.Errorf("the sessions reach aip %+v, want none", held)
	}
}
