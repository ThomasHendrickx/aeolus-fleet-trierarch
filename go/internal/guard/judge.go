package guard

import (
	"context"
	"errors"
	"path"
	"strings"
)

// judge applies the mechanism's checks, then each set on its own (design 4.6).
func (c Checker) judge(ctx context.Context, read call, sets []Set) *verdict {
	if read.isInternal {
		return nil
	}
	var shell *analysis
	if read.kind == kindShell {
		analyzed, err := analyzeShell(read.command, read.cwd, c.Home)
		if err != nil {
			return failed("shell input unparsable")
		}
		shell = analyzed
	}
	targets, made := read.fileWrites(), map[string]string{}
	if shell != nil {
		targets, made = shell.writes, shell.links
	}
	writes, refusal := c.resolveWrites(ctx, targets, made)
	if refusal != nil {
		return refusal
	}
	if refusal := c.protect(writes); refusal != nil {
		return refusal
	}
	if len(sets) > 0 {
		if read.kind == "" && !read.isAllMCP {
			return mechanism("unknown tool: " + read.tool)
		}
		if shell != nil {
			for _, run := range shell.invocations {
				if isHarness(run.name) {
					return mechanism("protected: harness")
				}
			}
			if len(shell.unresolvable) > 0 {
				return mechanism("unresolvable: " + shell.unresolvable[0])
			}
		}
		for _, w := range writes {
			if w.unresolvable != "" {
				return mechanism("unresolvable: " + w.unresolvable)
			}
		}
	}
	if refusal := c.bound(writes); refusal != nil {
		return refusal
	}
	for index := range sets {
		if refusal := c.judgeSet(&sets[index], read, shell, writes); refusal != nil {
			return refusal
		}
	}
	return nil
}

// resolvedWrite is a write target with its path made real.
type resolvedWrite struct {
	writeTarget
	real string
}

func (c Checker) resolveWrites(ctx context.Context, targets []writeTarget, made map[string]string) ([]resolvedWrite, *verdict) {
	writes := make([]resolvedWrite, 0, len(targets))
	for _, target := range targets {
		w := resolvedWrite{writeTarget: target}
		if target.unresolvable == "" {
			real, err := c.resolveTarget(ctx, target, made)
			switch {
			case errors.Is(err, errLinkLoop):
				return nil, failed("symbolic link loop")
			case ctx.Err() != nil:
				return nil, failed("deadline")
			case err != nil:
				return nil, failed("symbolic link unreadable")
			}
			w.real = real
		}
		writes = append(writes, w)
	}
	return writes, nil
}

// resolveTarget makes a write target real; a write to a path itself
// follows the links of its folder only.
func (c Checker) resolveTarget(ctx context.Context, target writeTarget, made map[string]string) (string, error) {
	if !target.own || target.path == "/" {
		return c.resolve(ctx, target.path, made)
	}
	folder, err := c.resolve(ctx, path.Dir(target.path), made)
	if err != nil {
		return "", err
	}
	return path.Join(folder, path.Base(target.path)), nil
}

// protect refuses a write to the guard's own files, its rules or the
// harness's settings, whatever the rules (design 4.6, step 2).
func (c Checker) protect(writes []resolvedWrite) *verdict {
	for _, w := range writes {
		if w.unresolvable != "" {
			continue
		}
		for _, p := range []string{w.real, w.path} {
			for _, pattern := range c.Protected {
				if hits(pattern, w.writeTarget, p) {
					return mechanism("protected: " + p)
				}
			}
		}
	}
	return nil
}

// bound refuses a write outside the ship's folder and its repositories
// (design 4.6, step 4).
func (c Checker) bound(writes []resolvedWrite) *verdict {
	for _, w := range writes {
		if w.unresolvable == "" && c.repositoryOf(w.real) == "" && !within(w.real, c.Boundary.ShipFolder) {
			return mechanism("outside the boundary: " + w.real)
		}
	}
	return nil
}

// repositoryOf is the repository a path lies in, "" when none.
func (c Checker) repositoryOf(p string) string {
	found := ""
	for _, repository := range c.Boundary.Repositories {
		if within(p, repository) && len(repository) > len(found) {
			found = path.Clean(repository)
		}
	}
	return found
}

// judgeSet is one set's verdict on the call: the first refusing rule.
func (c Checker) judgeSet(set *Set, read call, shell *analysis, writes []resolvedWrite) *verdict {
	tools := set.Rules.Tools
	if read.isAllMCP {
		for _, pattern := range tools.Deny {
			if restrictsMCP(pattern) {
				return &verdict{rule: "tools.deny " + pattern, set: set}
			}
		}
		if len(tools.Allow) > 0 {
			return &verdict{rule: "tools.allow restricts MCP resource listings", set: set}
		}
		return nil
	}
	for _, pattern := range tools.Deny {
		if wildcard(pattern, read.kind) {
			return &verdict{rule: "tools.deny " + pattern, set: set}
		}
	}
	if len(tools.Allow) > 0 && !anyWildcard(tools.Allow, read.kind) {
		return &verdict{rule: "tools.allow lacks " + read.kind, set: set}
	}
	if shell != nil {
		for _, run := range shell.invocations {
			if refusal := judgeCommand(set, run); refusal != nil {
				return refusal
			}
			if refusal := judgeGit(set, run); refusal != nil {
				return refusal
			}
		}
	}
	for _, w := range writes {
		if refusal := c.judgeWritePath(set, w); refusal != nil {
			return refusal
		}
	}
	return nil
}

// judgeWritePath checks a write against the set's writePaths, globs relative
// to the repository it lies in.
func (c Checker) judgeWritePath(set *Set, w resolvedWrite) *verdict {
	rules := set.Rules.WritePaths
	if w.unresolvable != "" || (len(rules.Allow) == 0 && len(rules.Deny) == 0) {
		return nil
	}
	repository := c.repositoryOf(w.real)
	if repository == "" {
		if len(rules.Allow) > 0 {
			return &verdict{rule: "writePaths.allow lacks " + w.real, set: set}
		}
		return nil
	}
	relative := strings.TrimPrefix(strings.TrimPrefix(w.real, repository), "/")
	if relative == "" {
		relative = "."
	}
	for _, pattern := range rules.Deny {
		if hits(pattern, w.writeTarget, relative) {
			return &verdict{rule: "writePaths.deny " + pattern, set: set}
		}
	}
	if len(rules.Allow) == 0 {
		return nil
	}
	for _, pattern := range rules.Allow {
		if globMatch(pattern, relative) {
			return nil
		}
	}
	return &verdict{rule: "writePaths.allow lacks " + relative, set: set}
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
// settings, ~/.claude/settings*.json and every .claude/settings*.json in each
// of its workspaces, the ship's folder and every folder its session works in
// (design 4.6, step 2).
func ClaudeCodeProtected(home, guardFolder, configuration string, workspaces ...string) []string {
	protected := []string{
		guardFolder + "/**",
		configuration,
		home + "/.claude/settings*.json",
	}
	for _, workspace := range workspaces {
		protected = append(protected, workspace+"/**/.claude/settings*.json")
	}
	return protected
}
