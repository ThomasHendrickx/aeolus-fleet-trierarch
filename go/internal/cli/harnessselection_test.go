package cli

import (
	"bytes"
	"errors"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
)

type scriptedTerminal struct {
	input *strings.Reader
	bytes.Buffer
}

func (s *scriptedTerminal) Read(p []byte) (int, error) { return s.input.Read(p) }
func (s *scriptedTerminal) Close() error               { return nil }

func TestInitPicksOnlyNamedHarnessesAndCaps(t *testing.T) {
	m := newMachine(t)
	withCodex(m, true)
	f := setupLine()
	f.Harnesses = []string{"codex"}
	f.Unattended = []string{"codex"}
	f.MaxShips = "7"
	f.MaxRunning = "3"
	if _, err := m.init.Run(f); err != nil {
		t.Fatal(err)
	}
	got, err := config.Load(m.init.Paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]config.Harness{"codex": {Flags: []string{"--dangerously-bypass-approvals-and-sandbox"}, Options: map[string]config.Option{}}}
	if !reflect.DeepEqual(got.Harnesses, want) || got.Caps != (config.Caps{Ships: 7, Running: 3}) {
		t.Fatalf("configuration = %+v, want only unattended Codex, caps 7/3", got)
	}
}

func TestInitSelectionStopsBeforeRegistration(t *testing.T) {
	for _, tc := range []struct {
		name       string
		harnesses  []string
		unattended []string
		ships      string
		running    string
		prepare    func(*aMachine)
		want       string
	}{
		{name: "missing selection even with yes", want: "--harnesses"},
		{name: "none picked", harnesses: []string{}, want: "at least one harness"},
		{name: "unknown harness", harnesses: []string{"cursor"}, want: "not supported"},
		{name: "not installed", harnesses: []string{"codex"}, want: "npm install -g @openai/codex"},
		{name: "not signed in", harnesses: []string{"claude-code"}, prepare: func(m *aMachine) { m.init.IsClaudeCodeSignedIn = false }, want: "claude auth login"},
		{name: "unattended not picked", harnesses: []string{"claude-code"}, unattended: []string{"codex"}, want: "subset"},
		{name: "zero ships", harnesses: []string{"claude-code"}, ships: "0", want: "--max-ships"},
		{name: "negative running", harnesses: []string{"claude-code"}, running: "-1", want: "--max-running"},
		{name: "noninteger ships", harnesses: []string{"claude-code"}, ships: "1.5", want: "--max-ships"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newMachine(t)
			if tc.prepare != nil {
				tc.prepare(m)
			}
			f := setupLine()
			f.Harnesses = tc.harnesses
			f.Unattended = tc.unattended
			f.MaxShips = tc.ships
			f.MaxRunning = tc.running
			_, err := m.init.Run(f)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
			if len(m.fleet.registered) != 0 {
				t.Fatal("registered a ship on a selection stop")
			}
			if _, err := os.Stat(m.init.Paths.CrewToken); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("wrote crew file on a selection stop")
			}
		})
	}
}

func TestInitWizardUsesTerminalAndNeverDefaultsAHarness(t *testing.T) {
	m := newMachine(t)
	withCodex(m, true)
	terminal := &scriptedTerminal{input: strings.NewReader("no\nyes\nno\nyes\n")}
	m.init.OpenTerminal = func() (io.ReadWriteCloser, error) { return terminal, nil }
	f := setupLine()
	f.Harnesses = nil
	f.IsYes = false
	if _, err := m.init.Run(f); err != nil {
		t.Fatal(err)
	}
	got, err := config.Load(m.init.Paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Harnesses) != 1 || !reflect.DeepEqual(got.Harnesses["codex"].Flags, []string{"--dangerously-bypass-approvals-and-sandbox"}) {
		t.Fatalf("harnesses = %+v", got.Harnesses)
	}
	for _, text := range []string{"Claude Code", "Codex", "Copilot", "signed in", "not installed", "run without permission questions?"} {
		if !strings.Contains(terminal.String(), text) {
			t.Errorf("terminal missing %q: %s", text, terminal.String())
		}
	}
}

func TestInitWizardBlankAnswersPickNothing(t *testing.T) {
	m := newMachine(t)
	terminal := &scriptedTerminal{input: strings.NewReader("\n\n\n")}
	m.init.OpenTerminal = func() (io.ReadWriteCloser, error) { return terminal, nil }
	f := setupLine()
	f.Harnesses = nil
	_, err := m.init.Run(f)
	if err == nil || !strings.Contains(err.Error(), "at least one harness") || len(m.fleet.registered) != 0 {
		t.Fatalf("error = %v, registered = %v", err, m.fleet.registered)
	}
}

func TestInitYesSkipsPermissionQuestionsButStillAsksHarnesses(t *testing.T) {
	m := newMachine(t)
	terminal := &scriptedTerminal{input: strings.NewReader("yes\nno\nno\n")}
	m.init.OpenTerminal = func() (io.ReadWriteCloser, error) { return terminal, nil }
	f := setupLine()
	f.Harnesses = nil
	if _, err := m.init.Run(f); err != nil {
		t.Fatal(err)
	}
	got, _ := config.Load(m.init.Paths.Config)
	if len(got.Harnesses["claude-code"].Flags) != 0 || strings.Contains(terminal.String(), "run without permission questions?") {
		t.Fatalf("configuration = %+v, terminal = %s", got, terminal.String())
	}
}
