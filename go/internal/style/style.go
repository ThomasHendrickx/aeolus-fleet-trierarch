// Package style is how the commands colour what they say, as today's
// trierarch does: the same ANSI codes Node's styleText writes, and colour only
// where a person reads a colour terminal. A tone names how a thing stands, not
// its colour.
package style

import "strings"

// Tone is how a thing stands.
type Tone int

const (
	Good Tone = iota
	Busy
	Bad
	Quiet
	Strong
)

// Style colours a text in a tone; Plain leaves it as it is.
type Style struct {
	isColour bool
}

// Plain is the style of a pipe, --json and a terminal that shows no colour.
var Plain = Style{}

// Colour is the style of a colour terminal.
var Colour = Style{isColour: true}

// codes are the opening and closing codes of each tone: green, yellow, red, dim and bold.
var codes = map[Tone][2]string{
	Good:   {"\x1b[32m", "\x1b[39m"},
	Busy:   {"\x1b[33m", "\x1b[39m"},
	Bad:    {"\x1b[31m", "\x1b[39m"},
	Quiet:  {"\x1b[2m", "\x1b[22m"},
	Strong: {"\x1b[1m", "\x1b[22m"},
}

// Tone is the text in the tone, or as it is where the style colours nothing.
func (s Style) Tone(tone Tone, text string) string {
	if !s.isColour {
		return text
	}
	return codes[tone][0] + text + codes[tone][1]
}

// Of is the style for a terminal: FORCE_COLOR turns colour on unless it is 0, NO_COLOR (https://no-color.org) and TERM=dumb turn it off, otherwise colour is for a terminal.
func Of(environ []string, isTerminal bool) Style {
	value := func(name string) (string, bool) {
		for _, entry := range environ {
			if key, found, ok := strings.Cut(entry, "="); ok && key == name {
				return found, true
			}
		}
		return "", false
	}
	if force, ok := value("FORCE_COLOR"); ok && force != "0" {
		return Colour
	}
	if no, ok := value("NO_COLOR"); ok && no != "" {
		return Plain
	}
	if term, _ := value("TERM"); term == "dumb" {
		return Plain
	}
	return Style{isColour: isTerminal}
}

// OfState is the tone an entry's state stands in: running is good, on its way is busy, crashed is bad, releasing is quiet.
func OfState(state string) Tone {
	switch state {
	case "running":
		return Good
	case "crewing", "restarting":
		return Busy
	case "crashed":
		return Bad
	}
	return Quiet
}
