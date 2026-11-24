package guard

import (
	"context"
	"slices"
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
	for index := range sets {
		set := &sets[index]
		if slices.Contains(set.Rules.Tools.Deny, read.kind) {
			return &verdict{rule: "tools.deny " + read.kind, set: set}
		}
	}
	return nil
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
