package main

import (
	"os"
	"path/filepath"
	"slices"
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

// aHeldAipCommand is the trierarch's aip folder as an install of the pin leaves it: aip and its Python in the venv's bin, links to aip and aip-spec alone in bin, and the plugin of aip's skills.
func aHeldAipCommand(t *testing.T, at paths.Paths) {
	t.Helper()
	files := map[string]string{
		filepath.Join("venv", "bin", "aip"):                          "#!/bin/sh\n",
		filepath.Join("venv", "bin", "python"):                       "#!/bin/sh\n",
		filepath.Join("venv", "bin", "aip-spec"):                     "#!/bin/sh\n",
		filepath.Join("plugin", ".claude-plugin", "plugin.json"):     `{"name":"aip"}`,
		filepath.Join("plugin", "skills", "aip-compile", "SKILL.md"): "---\nname: aip-compile\n---\n",
		filepath.Join("plugin", "skills", "aip-runtime", "SKILL.md"): "---\nname: aip-runtime\n---\n",
	}
	for name, text := range files {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(at.AipCommand, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(at.AipCommand, name), []byte(text), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(at.AipCommand, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"aip", "aip-spec"} {
		if err := os.Symlink(filepath.Join("..", "venv", "bin", name), filepath.Join(at.AipCommand, "bin", name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(at.AipCommandOutcome, []byte(`{"version":"`+aipcommand.Version+`"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHostSessionsRunTheAipTheTrierarchKeepsInItsHomeAndSessionsInContainersTheirImagesOwn(t *testing.T) {
	at := paths.Of(t.TempDir(), "")
	bin := filepath.Join(at.AipCommand, "bin")
	aHeldAipCommand(t, at)

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

func TestHostSessionsGetThePluginOfAipsSkillsTheTrierarchKeepsAndSessionsInContainersTheirImagesOwn(t *testing.T) {
	at := paths.Of(t.TempDir(), "")
	aHeldAipCommand(t, at)

	onTheHost := sessionRuntime(at, "aeolus-trierarch", config.Configuration{}).(sessions.Runtime).Aip
	inContainers := sessionRuntime(at, "aeolus-trierarch", config.Configuration{Runtime: &config.Runtime{Kind: "container", Binary: "podman"}}).(container.Runtime).Holds.Aip

	if onTheHost.Plugin == nil {
		t.Fatalf("host sessions get no plugin of aip's skills, want the trierarch's")
	}
	if got, ok := onTheHost.Plugin(); !ok || got != filepath.Join(at.AipCommand, "plugin") {
		t.Errorf("host sessions get the plugin %q, %v, want %s/plugin", got, ok, at.AipCommand)
	}
	if inContainers.Plugin != nil {
		t.Errorf("sessions in containers get the host's plugin of aip's skills, want their image's own")
	}
}

func TestTheServiceStartsFromAPathWithoutAnythingUnderTheAipCommandThatAnUpgradeFromAHostSessionCarried(t *testing.T) {
	at := paths.Of(t.TempDir(), "")
	carried := []string{"HOME=/home/me", "PATH=" + filepath.Join(at.AipCommand, "bin") + ":" + filepath.Join(at.AipCommand, "venv", "bin") + ":/usr/bin:" + filepath.Join(at.AipCommand, "venv", "bin") + ":/bin"}

	got := environWithoutAipCommand(carried, at)

	if want := []string{"HOME=/home/me", "PATH=/usr/bin:/bin"}; !slices.Equal(got, want) {
		t.Errorf("environWithoutAipCommand() = %q, want %q", got, want)
	}
}
