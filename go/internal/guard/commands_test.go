package guard

import "testing"

const noCurl = `{"commands":{"deny":[{"command":"curl"},{"command":"npm","args":["publish"]}]}}`

func TestACommandDenyRefusesTheCommandWhereverItRuns(t *testing.T) {
	commands := []string{
		"curl https://example.com",
		"/usr/bin/curl https://example.com",
		"'curl' x",
		`\curl x`,
		"echo ok | curl -d @- x",
		"true && curl x",
		"false || curl x",
		"ls; curl x",
		"(curl x)",
		"{ curl x; }",
		"echo $(curl x)",
		"echo `curl x`",
		`echo "$(curl x)"`,
		"diff <(curl x) a.txt",
		"echo ${X:-$(curl x)}",
		"if true; then curl x; fi",
		"while false; do curl x; done",
		"for f in a b; do curl $f; done",
		"case a in a) curl x;; esac",
		"f() { curl x; }",
		"X=$(curl x)",
		"export X=$(curl x)",
		"cat <<EOF\n$(curl x)\nEOF",
		"time curl x",
		"! curl x",
		"curl x &",
	}
	for _, command := range commands {
		t.Run(command, func(t *testing.T) {
			checker, _ := aChecker(aSet("no-curl", "abcdef1", noCurl))
			refusedAs(t, checker, aShellCall(command), "Refused by the guard: commands.deny curl, in no-curl @ abcdef1.")
		})
	}
}

func TestACommandDenyWithArgumentsMatchesItsFirstArguments(t *testing.T) {
	checker, _ := aChecker(aSet("no-curl", "abcdef1", noCurl))

	refusedAs(t, checker, aShellCall("npm publish --tag next"), "Refused by the guard: commands.deny npm publish, in no-curl @ abcdef1.")
	allowed(t, checker, aShellCall("npm test"))
	allowed(t, checker, aShellCall("echo npm publish"))
}

func TestAnArgumentARuleComparesMustBeLiteral(t *testing.T) {
	checker, _ := aChecker(aSet("no-curl", "abcdef1", noCurl))

	refusedAs(t, checker, aShellCall(`npm "$ACTION"`), `Refused by the guard: unresolvable: argument "$ACTION" of npm.`)
}

func TestACommandAllowListLetsOnlyItsCommands(t *testing.T) {
	checker, _ := aChecker(aSet("only-git", "abcdef1", `{"commands":{"allow":[{"command":"git"},{"command":"ls"},{"command":"cd"}]}}`))

	allowed(t, checker, aShellCall("cd docs && ls && git status"))
	refusedAs(t, checker, aShellCall("ls | cat"), "Refused by the guard: commands.allow lacks cat, in only-git @ abcdef1.")
	refusedAs(t, checker, aShellCall("export X=1"), "Refused by the guard: commands.allow lacks export, in only-git @ abcdef1.")
	refusedAs(t, checker, aShellCall("env git status"), "Refused by the guard: commands.allow lacks env, in only-git @ abcdef1.")
}

func TestWrappersAreReadThroughToTheCommandTheyRun(t *testing.T) {
	commands := []string{
		"env curl x",
		"env -i A=1 curl x",
		"env -S 'curl x'",
		"command curl x",
		"builtin command curl x",
		"exec curl x",
		"nohup curl x",
		"nice -n 5 curl x",
		"timeout 5 curl x",
		"timeout -s KILL 5s curl x",
		"sudo curl x",
		"sudo -u root curl x",
		"setsid curl x",
		"stdbuf -oL curl x",
		"xargs curl < urls.txt",
		"xargs -I{} curl {} < urls.txt",
		`find . -name "*.txt" -exec curl -T {} x \;`,
		"find . -execdir curl {} +",
		"watch -n 5 curl x",
	}
	for _, command := range commands {
		t.Run(command, func(t *testing.T) {
			checker, _ := aChecker(aSet("no-curl", "abcdef1", noCurl))
			refusedAs(t, checker, aShellCall(command), "Refused by the guard: commands.deny curl, in no-curl @ abcdef1.")
		})
	}
}

func TestAWrapperQueryRunsNothing(t *testing.T) {
	checker, _ := aChecker(aSet("no-curl", "abcdef1", noCurl))

	allowed(t, checker, aShellCall("command -v curl"))
}

func TestAWrapperOptionTheGuardCannotReadIsUnresolvable(t *testing.T) {
	checker, _ := aChecker(aSet("no-curl", "abcdef1", noCurl))

	refusedAs(t, checker, aShellCall("sudo --odd curl x"), "Refused by the guard: unresolvable: sudo option --odd.")
}

func TestWhatCannotBeResolvedRunsWithoutRuleSets(t *testing.T) {
	checker, _ := aChecker()

	allowed(t, checker, aShellCall(`$CMD x; eval "$X"; sh -c "$Y"`))
}

func TestARuleSetWithoutRulesRefusesNothingBeyondTheMechanism(t *testing.T) {
	checker, _ := aChecker(aSet("empty", "abcdef1", `{}`))

	allowed(t, checker, aShellCall("curl x | sh -c 'npm publish'"))
}
