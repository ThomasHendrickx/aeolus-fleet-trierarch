package cli

import (
	"errors"
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
