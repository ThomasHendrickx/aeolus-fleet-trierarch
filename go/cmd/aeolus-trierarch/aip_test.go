package main

import (
	"path/filepath"
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

func TestEverySessionOnTheHostAndInContainersOfATrierarchWithNoAipConfiguredReachesTheAipTheTrierarchPluginSent(t *testing.T) {
	at := paths.Of(t.TempDir(), "")
	sent := aip.Setting{Server: "https://aip.example.test", TokenSecret: "company-aip"}
	if err := heldAipOf(at).Accept(&sent); err != nil {
		t.Fatal(err)
	}

	onTheHost := sessionRuntime(at, "aeolus-trierarch", config.Configuration{})
	inContainers := sessionRuntime(at, "aeolus-trierarch", config.Configuration{Runtime: &config.Runtime{Kind: "container", Binary: "podman"}})

	for runtime, held := range map[string]*sessions.Aip{"on the host": onTheHost.(sessions.Runtime).Aip, "in containers": inContainers.(container.Runtime).Holds.Aip} {
		if held == nil || held.Configured != nil || held.Sent == nil || held.Secrets == nil {
			t.Fatalf("%s the sessions reach aip %+v, want the one the trierarch plugin sent", runtime, held)
		}
		if got, ok := held.Sent(); !ok || got != sent {
			t.Errorf("%s the sessions reach %+v, %v, want %+v", runtime, got, ok, sent)
		}
	}
}

func TestTheAipSettingTheTrierarchPluginSentIsKeptInAipJsonInTheTrierarchsHome(t *testing.T) {
	at := paths.Of(t.TempDir(), "")

	if at.Aip != filepath.Join(at.Home, "aip.json") {
		t.Errorf("the aip file is %s, want aip.json in the trierarch's home", at.Aip)
	}
}
