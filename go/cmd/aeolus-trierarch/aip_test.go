package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/aip"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/aipcommand"
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

func TestHostSessionsRunTheAipTheTrierarchKeepsInItsHomeAndSessionsInContainersTheirImagesOwn(t *testing.T) {
	at := paths.Of(t.TempDir(), "")
	bin := filepath.Join(at.AipCommand, "venv", "bin")
	for _, name := range []string{"aip", "python"} {
		if err := os.MkdirAll(bin, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(at.AipCommandOutcome, []byte(`{"version":"`+aipcommand.Version+`"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	onTheHost := sessionRuntime(at, "aeolus-trierarch", config.Configuration{}).(sessions.Runtime).Aip
	inContainers := sessionRuntime(at, "aeolus-trierarch", config.Configuration{Runtime: &config.Runtime{Kind: "container", Binary: "podman"}}).(container.Runtime).Holds.Aip

	if onTheHost.Command == nil || onTheHost.Path != os.Getenv("PATH") {
		t.Fatalf("host sessions run aip %+v, want the trierarch's in front of its own PATH", onTheHost)
	}
	if got, ok := onTheHost.Command(); !ok || got != bin {
		t.Errorf("host sessions run the aip in %q, %v, want %s", got, ok, bin)
	}
	if inContainers.Command != nil {
		t.Errorf("sessions in containers run the host's aip, want their image's own")
	}
}

func TestTheAipCommandIsKeptInTheTrierarchsHome(t *testing.T) {
	at := paths.Of(t.TempDir(), "")

	if at.AipCommand != filepath.Join(at.Home, "aip-command") || at.AipCommandOutcome != filepath.Join(at.Home, "aip-command.json") {
		t.Errorf("the aip command is kept in %s and %s, want aip-command and aip-command.json in the trierarch's home", at.AipCommand, at.AipCommandOutcome)
	}
}
