package guard

import "testing"

func TestAdditionalShellEntryPointsCannotReadInteractiveCommandsWithRules(t *testing.T) {
	checker, _ := aChecker(aSet("rules", "abcdef1", `{}`))
	withoutRules, _ := aChecker()
	for _, command := range []string{
		"fish", "fish --interactive -c 'echo hello'", "csh", "tcsh -i ./script.csh",
		"busybox sh", "/usr/bin/busybox ash -i ./script.sh",
		"script", "script /dev/null", "tmux", "tmux new-session", "screen", "screen -r session",
	} {
		t.Run(command, func(t *testing.T) {
			refusedAs(t, checker, aShellCall(command), "Refused by the guard: unresolvable: reads commands from stdin.")
			allowed(t, withoutRules, aShellCall(command))
		})
	}
}

func TestAdditionalShellEntryPointsCheckLiteralCommandText(t *testing.T) {
	checker, _ := aChecker(aSet("rules", "abcdef1", `{}`))
	for _, command := range []string{
		"fish -c 'codex --version'", "fish --command='codex --version'", "csh -c 'codex --version'",
		"tcsh -c 'codex --version'", "busybox sh -c 'codex --version'",
	} {
		t.Run(command, func(t *testing.T) {
			refusedAs(t, checker, aShellCall(command), "Refused by the guard: protected: harness.")
		})
	}
	for _, command := range []string{
		"fish --command 'echo hello'", "csh ./script.csh", "tcsh -c 'echo hello'",
		"busybox sh -c 'echo hello'", "busybox echo sh",
	} {
		t.Run(command, func(t *testing.T) { allowed(t, checker, aShellCall(command)) })
	}
}
