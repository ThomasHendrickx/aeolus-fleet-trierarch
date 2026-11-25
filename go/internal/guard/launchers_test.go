package guard

import "testing"

func TestPackageLaunchersCannotStartAHarnessWhileRulesApply(t *testing.T) {
	for _, command := range []string{
		"npx @openai/codex",
		"npx --yes @openai/codex@latest",
		"npx -p @openai/codex -- codex",
		"bunx --bun @anthropic-ai/claude-code",
		"pnpm --silent dlx @github/copilot",
		"npm exec --package=@openai/codex -- codex",
		"npm exec --call 'codex --version'",
		"yarn dlx -p @anthropic-ai/claude-code claude",
		"bun x @openai/codex",
		"pnpm exec codex",
		"corepack pnpm dlx codex",
		"env NODE_ENV=test /usr/local/bin/npx -- @openai/codex",
	} {
		t.Run(command, func(t *testing.T) {
			checker, _ := aChecker(aSet("rules", "abcdef1", `{}`))
			refusedAs(t, checker, aShellCall(command), "Refused by the guard: protected: harness.")
			withoutRules, _ := aChecker()
			allowed(t, withoutRules, aShellCall(command))
		})
	}
}

func TestPackageLaunchersCanRunAResolvedNonHarnessWithRules(t *testing.T) {
	checker, _ := aChecker(aSet("rules", "abcdef1", `{}`))
	for _, command := range []string{
		"npx --yes prettier@latest --check codex",
		"npm exec --package=prettier -- prettier codex",
		"npm test -- codex",
		"bunx prettier --check codex",
		"pnpm dlx prettier --check codex",
	} {
		t.Run(command, func(t *testing.T) { allowed(t, checker, aShellCall(command)) })
	}
}

func TestPackageLaunchersRequireAResolvableTargetWithRules(t *testing.T) {
	checker, _ := aChecker(aSet("rules", "abcdef1", `{}`))
	for _, command := range []string{
		"npx \"$PACKAGE\"",
		"bunx --package \"$PACKAGE\" prettier",
		"pnpm dlx --package=\"$PACKAGE\" prettier",
		"npm exec --call \"$COMMAND\"",
	} {
		t.Run(command, func(t *testing.T) {
			refusedAs(t, checker, aShellCall(command), "Refused by the guard: unresolvable: package launcher target.")
		})
	}
}
