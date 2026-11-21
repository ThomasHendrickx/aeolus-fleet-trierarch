package cli

import (
	"context"
	"errors"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/tui"
	tea "github.com/charmbracelet/bubbletea"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/style"
)

func TestTUIWithoutBothTerminalsExitsTwoAndNamesPlainStatus(t *testing.T) {
	for _, test := range []struct {
		name          string
		input, output bool
	}{{"neither", false, false}, {"piped input", false, true}, {"piped output", true, false}} {
		t.Run(test.name, func(t *testing.T) {
			ran := false
			machine := Machine{HomeDirectory: t.TempDir(), IsTerminal: test.output, IsInputTerminal: func() bool { return test.input }, RunTUI: func(paths.Paths, style.Style) error { ran = true; return nil }}
			got, code := Main([]string{"tui"}, machine)
			want := "tui needs a terminal: read one ship with aeolus-trierarch status <ship> --json"
			if code != 2 || got != want || ran {
				t.Fatalf("Main(tui, %s) = %q, code %d, ran %v; want %q, 2, false", test.name, got, code, ran, want)
			}
		})
	}
}

func TestTUIStartsWithTheSelectedLocalPaths(t *testing.T) {
	home := t.TempDir()
	var gotPath string
	machine := Machine{HomeDirectory: home, IsTerminal: true, IsInputTerminal: func() bool { return true }, RunTUI: func(at paths.Paths, _ style.Style) error { gotPath = at.Config; return nil }}
	got, code := Main([]string{"tui", "--config", "/chosen/config.json"}, machine)
	if got != "" || code != 0 || gotPath != "/chosen/config.json" {
		t.Fatalf("Main(tui --config) = %q, code %d, path %q; want empty, 0, /chosen/config.json", got, code, gotPath)
	}
}

func TestTUINamesAProgramFailure(t *testing.T) {
	machine := Machine{HomeDirectory: t.TempDir(), IsTerminal: true, IsInputTerminal: func() bool { return true }, RunTUI: func(paths.Paths, style.Style) error { return errors.New("terminal closed") }}
	got, code := Main([]string{"tui"}, machine)
	if code != 1 || !strings.Contains(got, "terminal closed") {
		t.Fatalf("Main(tui failed) = %q, %d; want terminal closed, 1", got, code)
	}
}

func TestHelpNamesTheLiveModeAndPlainShipStatus(t *testing.T) {
	got, code := Main([]string{"--help"}, Machine{})
	if code != 0 {
		t.Fatalf("Main(--help) code = %d, want 0", code)
	}
	for _, want := range []string{"status <ship>", "one ship, by its name or id", "tui", "the same, live, full screen"} {
		if !strings.Contains(got, want) {
			t.Fatalf("Main(--help) = %s, want %q", got, want)
		}
	}
}

func TestLiveAndPlainStatusShareWholeMaskedLinesBeforeTheTerminalCut(t *testing.T) {
	machine, at := aShipStatus(t)
	raw := `{"type":"assistant","message":{"content":[{"type":"text","text":"SECRET-CREW-TOKEN ` + strings.Repeat("whole-line-", 30) + `"}]}}`
	writeStatusFile(t, filepath.Join(at.Sessions, "shp_one", "events.jsonl"), raw+"\n")
	plain, code := Main([]string{"status", "shp_one"}, machine)
	if code != 0 || !strings.Contains(plain, strings.Repeat("whole-line-", 30)) {
		t.Fatalf("status(long line) = %s, code %d; want whole line, 0", plain, code)
	}
	source := localViews{at: at}
	m := tui.New(source, style.Plain)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 140, Height: 40})
	m = next.(tui.Model)
	first := m.Init()().(tea.BatchMsg)[0]()
	next, _ = m.Update(first)
	m = next.(tui.Model)
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(tui.Model)
	next, _ = m.Update(cmd())
	m = next.(tui.Model)
	live := m.View()
	if !strings.Contains(live, "[masked: crew token]") || !strings.Contains(live, "…") || strings.Contains(live, strings.Repeat("whole-line-", 30)) {
		t.Fatalf("tui(long masked line) = %s, want masked text clipped with ellipsis", live)
	}
	for _, out := range []string{plain, live} {
		if strings.Contains(out, "SECRET-CREW-TOKEN") {
			t.Fatal("status/tui(fake credential) exposed value, want masked")
		}
	}
}

func TestLiveSourceReadsStandingAndKeptEnd(t *testing.T) {
	machine, at := aShipStatus(t)
	writeStatusFile(t, filepath.Join(at.Home, "ended", "shp_one.json"), `{"exitReason":"exit status 101","lines":[]}`)
	source := localViews{at: at}
	rows, ship, err := source.Read(context.Background(), "shp_one", machine.Now())
	if err != nil {
		t.Fatal(err)
	}
	if ship.LastEnd == nil || ship.LastEnd.ExitReason != "exit status 101" {
		t.Fatalf("Read end = %+v, want exit status 101", ship.LastEnd)
	}
	if ship.Trierarch.Service != "not running" || len(rows.Ships[0].Trierarch.Says) == 0 {
		t.Fatalf("Read standing = %+v, rows %+v, want service warning", ship.Trierarch, rows.Ships)
	}
}
