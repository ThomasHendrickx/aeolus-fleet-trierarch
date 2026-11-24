package guard

import (
	"context"
	"strings"
)

// judge applies the mechanism's checks, then each set on its own (design 4.6).
func (c Checker) judge(_ context.Context, read call, sets []Set) *verdict {
	var shell *analysis
	if read.kind == kindShell {
		analyzed, err := analyzeShell(read.command, read.cwd, c.Home)
		if err != nil {
			return failed("shell input unparsable")
		}
		shell = analyzed
	}
	if len(sets) == 0 {
		return nil
	}
	if read.kind == "" {
		return mechanism("unknown tool: " + read.tool)
	}
	if shell != nil && len(shell.unresolvable) > 0 {
		return mechanism("unresolvable: " + shell.unresolvable[0])
	}
	for index := range sets {
		if refusal := judgeSet(&sets[index], read, shell); refusal != nil {
			return refusal
		}
	}
	return nil
}

// judgeSet is one set's verdict on the call: the first refusing rule.
func judgeSet(set *Set, read call, shell *analysis) *verdict {
	tools := set.Rules.Tools
	for _, pattern := range tools.Deny {
		if wildcard(pattern, read.kind) {
			return &verdict{rule: "tools.deny " + pattern, set: set}
		}
	}
	if len(tools.Allow) > 0 && !anyWildcard(tools.Allow, read.kind) {
		return &verdict{rule: "tools.allow lacks " + read.kind, set: set}
	}
	if shell == nil {
		return nil
	}
	for _, run := range shell.invocations {
		if refusal := judgeCommand(set, run); refusal != nil {
			return refusal
		}
		if refusal := judgeGit(set, run); refusal != nil {
			return refusal
		}
	}
	return nil
}

// judgeCommand checks one command the shell runs against the set's command rules.
func judgeCommand(set *Set, run invocation) *verdict {
	rules := set.Rules.Commands
	for _, rule := range rules.Deny {
		matched, unresolvable := matchCommand(rule, run)
		if unresolvable != "" {
			return mechanism("unresolvable: " + unresolvable)
		}
		if matched {
			return &verdict{rule: "commands.deny " + strings.Join(append([]string{rule.Command}, rule.Args...), " "), set: set}
		}
	}
	if len(rules.Allow) == 0 {
		return nil
	}
	for _, rule := range rules.Allow {
		matched, unresolvable := matchCommand(rule, run)
		if unresolvable != "" {
			return mechanism("unresolvable: " + unresolvable)
		}
		if matched {
			return nil
		}
	}
	return &verdict{rule: "commands.allow lacks " + run.name, set: set}
}

// matchCommand is whether the command is the rule's command with its first
// arguments; an argument the rule compares that is not literal is unresolvable.
func matchCommand(rule CommandRule, run invocation) (bool, string) {
	if run.name != rule.Command {
		return false, ""
	}
	if len(run.args) < len(rule.Args) {
		return false, ""
	}
	for index, want := range rule.Args {
		arg := run.args[index]
		if !arg.literal {
			return false, "argument " + arg.source + " of " + run.name
		}
		if arg.text != want {
			return false, ""
		}
	}
	return true, ""
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
