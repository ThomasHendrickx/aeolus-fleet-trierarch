package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/modelproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

func TestInContainersClaudeCodeStartsARequestWithARuleSetGuardedThroughItsShipsSocket(t *testing.T) {
	at := paths.Of(t.TempDir(), "")
	configuration := config.Configuration{
		Runtime:   &config.Runtime{Kind: "container", Binary: "podman", Memory: "2g", Cpus: 2},
		Harnesses: map[string]config.Harness{"claude-code": {Flags: []string{"--dangerously-skip-permissions", "--model", "opus"}, Options: map[string]config.Option{}}},
	}
	pluginRoot, err := filepath.Abs(filepath.Join("..", "..", "..", "plugins", "aeolus-fleet"))
	if err != nil {
		t.Fatal(err)
	}
	running := &startedSessions{}
	wired, _, err := harnessesOf(configuration, at, map[string]string{"AEOLUS_PLUGIN_ROOT": pluginRoot}, t.TempDir(), "/usr/local/bin/aeolus-trierarch", running, modelproxy.Runtime{Folder: at.Proxy}, &offers{configured: configuration})
	if err != nil {
		t.Fatal(err)
	}
	harness, ok := wired["claude-code"].(interface {
		Launch(entry reconciler.Entry, isFirstStart bool, launchID string) error
	})
	if !ok {
		t.Fatalf("claude-code is wired as %T, want a harness that launches", wired["claude-code"])
	}
	rules := `{"shipId":"` + realContainerShip + `","settingsVersion":1,"sets":` + realNoTouch + `}`
	if err := (guardfile.Store{Guards: at.Guard}).Write(context.Background(), realContainerShip, []byte(rules)); err != nil {
		t.Fatal(err)
	}

	if err := harness.Launch(reconciler.Entry{ShipID: realContainerShip, ShipName: "scout", SettingsVersion: 1, Harness: "claude-code", Folder: t.TempDir(), Options: map[string]string{}}, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	command := strings.Join(running.started[0].Command, " ")
	if want := "--unix-socket '" + filepath.Join(at.Sockets, realContainerShip, "fleet.sock") + "'"; !strings.Contains(command, want) {
		t.Fatalf("command %s, want the guard hook asking %s", command, want)
	}
}
