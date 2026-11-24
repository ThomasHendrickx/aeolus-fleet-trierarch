package guard

import (
	"context"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// judge applies the mechanism's checks, then each set on its own (design 4.6).
func (c Checker) judge(_ context.Context, read call, sets []Set) *verdict {
	if read.kind == kindShell {
		if _, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(strings.NewReader(read.command), ""); err != nil {
			return failed("shell input unparsable")
		}
	}
	if len(sets) == 0 {
		return nil
	}
	if read.kind == "" {
		return mechanism("unknown tool: " + read.tool)
	}
	for index := range sets {
		if refusal := judgeSet(&sets[index], read); refusal != nil {
			return refusal
		}
	}
	return nil
}

// judgeSet is one set's verdict on the call: the first refusing rule.
func judgeSet(set *Set, read call) *verdict {
	tools := set.Rules.Tools
	for _, pattern := range tools.Deny {
		if wildcard(pattern, read.kind) {
			return &verdict{rule: "tools.deny " + pattern, set: set}
		}
	}
	if len(tools.Allow) > 0 && !anyWildcard(tools.Allow, read.kind) {
		return &verdict{rule: "tools.allow lacks " + read.kind, set: set}
	}
	return nil
}

func anyWildcard(patterns []string, text string) bool {
	for _, pattern := range patterns {
		if wildcard(pattern, text) {
			return true
		}
	}
	return false
}

// wildcard matches text against a pattern whose * stands for any characters.
func wildcard(pattern, text string) bool {
	head, rest, starred := strings.Cut(pattern, "*")
	if !starred {
		return pattern == text
	}
	if !strings.HasPrefix(text, head) {
		return false
	}
	text = text[len(head):]
	for i := 0; i <= len(text); i++ {
		if wildcard(rest, text[i:]) {
			return true
		}
	}
	return false
}

// ClaudeCodeProtected are the paths no call of a Claude Code session writes:
// the guard's state folder, the trierarch's configuration and the harness's
// settings, ~/.claude/settings*.json and every .claude/settings*.json in the
// ship's folder (design 4.6, step 2).
func ClaudeCodeProtected(home, shipFolder, guardFolder, configuration string) []string {
	return []string{
		guardFolder + "/**",
		configuration,
		home + "/.claude/settings*.json",
		shipFolder + "/**/.claude/settings*.json",
	}
}
