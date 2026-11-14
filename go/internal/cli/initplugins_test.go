package cli

import (
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
)

// registeringPlugins notes how many ships were registered when each plugin was installed.
type registeringPlugins struct {
	*somePlugins
	fleet        *aFleet
	registeredAt []int
}

func (p *registeringPlugins) Update(harness string, tag string) error {
	p.registeredAt = append(p.registeredAt, len(p.fleet.registered))
	return p.somePlugins.Update(harness, tag)
}

func withAllHarnesses(m *aMachine) {
	withCodex(m, true)
	m.init.IsCopilotInstalled = true
}

func TestInitInstallsThePluginOfEachPickedHarnessAtThisVersionsTagBeforeRegistering(t *testing.T) {
	m := newMachine(t)
	withAllHarnesses(m)
	watching := &registeringPlugins{somePlugins: m.plugins, fleet: m.fleet}
	m.init.Plugins = watching
	f := setupLine()
	f.Harnesses = []string{"claude-code", "codex", "copilot"}

	if _, err := m.init.Run(f); err != nil {
		t.Fatal(err)
	}

	slices.Sort(m.plugins.updates)
	want := []string{"claude-code v" + Version, "codex v" + Version, "copilot v" + Version}
	if !slices.Equal(m.plugins.updates, want) {
		t.Fatalf("plugins installed = %v, want %v", m.plugins.updates, want)
	}
	if !slices.Equal(watching.registeredAt, []int{0, 0, 0}) {
		t.Fatalf("ships registered when each plugin was installed = %v, want none", watching.registeredAt)
	}
}

func TestInitInstallsThePluginOfAPickedHarnessOnly(t *testing.T) {
	m := newMachine(t)
	withAllHarnesses(m)

	if _, err := m.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}

	if !slices.Equal(m.plugins.updates, []string{"claude-code v" + Version}) {
		t.Fatalf("plugins installed = %v, want Claude Code's only", m.plugins.updates)
	}
}

func TestInitLeavesAPluginAlreadyAtTheTagAsItIs(t *testing.T) {
	m := newMachine(t)
	m.plugins.versions["claude-code"] = Version

	if _, err := m.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}

	if len(m.plugins.updates) != 0 {
		t.Fatalf("plugins installed = %v, want none: it is at the tag", m.plugins.updates)
	}
}

func TestInitInstallsThePluginAgainWhereItIsAtAnotherVersion(t *testing.T) {
	m := newMachine(t)
	m.plugins.versions["claude-code"] = "0.1.0"

	if _, err := m.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}

	if !slices.Equal(m.plugins.updates, []string{"claude-code v" + Version}) {
		t.Fatalf("plugins installed = %v, want Claude Code's moved to the tag", m.plugins.updates)
	}
}

func TestInitStopsNamingTheHarnessWhenItsPluginCannotBeInstalledAndTouchesTheFleetNot(t *testing.T) {
	for _, harness := range []string{"claude-code", "codex", "copilot"} {
		t.Run(harness, func(t *testing.T) {
			m := newMachine(t)
			withAllHarnesses(m)
			m.init.Plugins = &failingPlugins{somePlugins: m.plugins, harness: harness, err: errors.New("marketplace unreachable")}
			f := setupLine()
			f.Harnesses = []string{"claude-code", "codex", "copilot"}

			_, err := m.init.Run(f)

			name := map[string]string{"claude-code": "Claude Code", "codex": "Codex", "copilot": "Copilot"}[harness]
			if err == nil || !strings.Contains(err.Error(), name) || !strings.Contains(err.Error(), "marketplace unreachable") {
				t.Fatalf("error = %v, want it naming %s and its reason", err, name)
			}
			if len(m.fleet.registered) != 0 {
				t.Fatal("registered a ship although a plugin was not installed")
			}
			for _, file := range []string{m.init.Paths.CrewToken, m.init.Paths.Config} {
				if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("%s written although a plugin was not installed", file)
				}
			}
			if len(m.service.calls) != 0 {
				t.Fatalf("service calls = %v, want none", m.service.calls)
			}
		})
	}
}

func TestInitRunAgainAfterAPluginFailureStartsOver(t *testing.T) {
	m := newMachine(t)
	m.init.Plugins = &failingPlugins{somePlugins: m.plugins, harness: "claude-code", err: errors.New("offline")}
	if _, err := m.init.Run(setupLine()); err == nil {
		t.Fatal("want the install to stop")
	}
	m.init.Plugins = m.plugins

	if _, err := m.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}

	if !slices.Equal(m.fleet.registered, []string{shipID}) {
		t.Fatalf("registered = %v, want the ship once", m.fleet.registered)
	}
}

type failingPlugins struct {
	*somePlugins
	harness string
	err     error
}

func (p *failingPlugins) Update(harness string, tag string) error {
	if harness == p.harness {
		return p.err
	}
	return p.somePlugins.Update(harness, tag)
}
