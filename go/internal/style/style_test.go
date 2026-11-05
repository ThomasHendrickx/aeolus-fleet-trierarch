package style

import "testing"

func TestTheCodesAreThoseNodeWrites(t *testing.T) {
	for tone, want := range map[Tone]string{Good: "\x1b[32mx\x1b[39m", Busy: "\x1b[33mx\x1b[39m", Bad: "\x1b[31mx\x1b[39m", Quiet: "\x1b[2mx\x1b[22m", Strong: "\x1b[1mx\x1b[22m"} {
		if got := Colour.Tone(tone, "x"); got != want {
			t.Errorf("tone %d gave %q, want %q", tone, got, want)
		}
		if got := Plain.Tone(tone, "x"); got != "x" {
			t.Errorf("plain gave %q", got)
		}
	}
}

func TestColourIsForATerminalUnlessTheEnvironmentSaysOtherwise(t *testing.T) {
	for name, test := range map[string]struct {
		environ    []string
		isTerminal bool
		want       Style
	}{
		"a terminal":                  {nil, true, Colour},
		"a pipe":                      {nil, false, Plain},
		"forced":                      {[]string{"FORCE_COLOR=1"}, false, Colour},
		"FORCE_COLOR=0 on a terminal": {[]string{"FORCE_COLOR=0"}, true, Colour},
		"forced beats no colour":      {[]string{"FORCE_COLOR=1", "NO_COLOR=1"}, false, Colour},
		"no colour":                   {[]string{"NO_COLOR=1"}, true, Plain},
		"empty no colour":             {[]string{"NO_COLOR="}, true, Colour},
		"a dumb terminal":             {[]string{"TERM=dumb"}, true, Plain},
	} {
		if got := Of(test.environ, test.isTerminal); got != test.want {
			t.Errorf("%s: %v, want %v", name, got, test.want)
		}
	}
}

func TestAStateStandsInItsTone(t *testing.T) {
	for state, want := range map[string]Tone{"running": Good, "crewing": Busy, "restarting": Busy, "crashed": Bad, "releasing": Quiet} {
		if got := OfState(state); got != want {
			t.Errorf("%s: %d, want %d", state, got, want)
		}
	}
}
