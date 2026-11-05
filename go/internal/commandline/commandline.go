// Package commandline is a harness's command line in parts, each marked by
// where its words come from: the configuration's flags, or what the adapter
// adds itself. A launch runs the words; config check prints the parts, so the
// operator sees what will launch and why.
package commandline

import "strings"

// Source is where a part's words come from.
type Source string

const (
	Configuration Source = "configuration"
	Adapter       Source = "adapter"
)

// Part is some words of a command line. The program and the prompt carry no source.
type Part struct {
	Words  []string `json:"words"`
	Source Source   `json:"source,omitempty"`
	// When says when the words apply, where config check cannot know it: the launch knows and runs them or not.
	When string `json:"when,omitempty"`
}

// AdapterFlag is a flag an adapter adds itself: to every launch, or to a restart only.
type AdapterFlag struct {
	Flag string `json:"flag"`
	When string `json:"when"`
}

// Words are the words of the parts, in order.
func Words(parts []Part) []string {
	words := []string{}
	for _, part := range parts {
		words = append(words, part.Words...)
	}
	return words
}

// WithWords are the parts with words in them: a configuration with no flags adds no empty part.
func WithWords(parts []Part) []Part {
	kept := []Part{}
	for _, part := range parts {
		if len(part.Words) > 0 {
			kept = append(kept, part)
		}
	}
	return kept
}

// Describe is one line: each part's words, a word with a space in quotes and its line breaks as \n, and each flag part followed by its source and when it applies.
func Describe(parts []Part) string {
	described := make([]string, 0, len(parts))
	for _, part := range parts {
		words := make([]string, 0, len(part.Words))
		for _, word := range part.Words {
			if strings.Contains(word, " ") {
				word = `"` + strings.ReplaceAll(word, "\n", `\n`) + `"`
			}
			words = append(words, word)
		}
		line := strings.Join(words, " ")
		switch {
		case part.Source == "":
		case part.When == "":
			line += " (" + string(part.Source) + ")"
		default:
			line += " (" + string(part.Source) + ", when " + part.When + ")"
		}
		described = append(described, line)
	}
	return strings.Join(described, " ")
}
