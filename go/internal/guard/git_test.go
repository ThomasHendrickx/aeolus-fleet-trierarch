package guard

import "testing"

// gitCase is a command and the git action a set that denies it refuses it as.
type gitCase struct {
	action, command string
}

func TestEachGitActionIsReadFromTheParsedGitCommand(t *testing.T) {
	cases := []gitCase{
		{"push", "git push"},
		{"push", "git push origin main"},
		{"push", "git send-pack origin main"},
		{"push", "git -C ../other push"},
		{"push", "git -c user.name=x push"},
		{"push", "git --git-dir=.git --work-tree . push"},
		{"push", "git --no-pager -P push"},
		{"push", "/usr/bin/git push"},
		{"force-push", "git push --force"},
		{"force-push", "git push -f origin main"},
		{"force-push", "git push -uf origin main"},
		{"force-push", "git push --force-with-lease"},
		{"force-push", "git push --force-with-lease=main:abc origin main"},
		{"force-push", "git push origin +main"},
		{"force-push", "git push --forc"},
		{"skip-hooks", "git commit --no-verify -m x"},
		{"skip-hooks", "git commit -n -m x"},
		{"skip-hooks", "git commit -anm x"},
		{"skip-hooks", "git commit --no-verif -m x"},
		{"skip-hooks", "git push --no-verify"},
		{"skip-hooks", "git merge --no-verify topic"},
		{"skip-hooks", "git pull --no-verify"},
		{"skip-hooks", "git am --no-verify a.patch"},
		{"skip-hooks", "git config core.hooksPath /tmp/hooks"},
		{"skip-hooks", "git config --global core.hookspath /tmp/hooks"},
		{"rewrite-history", "git rebase -i main"},
		{"rewrite-history", "git reset --hard HEAD~1"},
		{"rewrite-history", "git reset --har HEAD~1"},
		{"rewrite-history", "git commit --amend --no-edit"},
		{"rewrite-history", "git filter-branch --tree-filter x"},
		{"rewrite-history", "git filter-repo --path x"},
		{"delete-branch", "git branch -d topic"},
		{"delete-branch", "git branch -D topic"},
		{"delete-branch", "git branch -rd origin/topic"},
		{"delete-branch", "git branch --delete topic"},
		{"delete-branch", "git push origin --delete topic"},
		{"delete-branch", "git push -d origin topic"},
		{"delete-branch", "git push origin :topic"},
		{"delete-branch", "git update-ref -d refs/heads/topic"},
		{"change-remote", "git remote add fork https://example.com/x.git"},
		{"change-remote", "git remote set-url origin https://example.com/x.git"},
		{"change-remote", "git remote remove origin"},
		{"change-remote", "git remote rm origin"},
		{"change-config", "git config user.name x"},
		{"change-config", "git config --global user.name x"},
		{"change-config", "git config --unset user.name"},
		{"change-config", "git config --add a.b c"},
		{"change-config", "git config set user.name x"},
		{"change-config", "git config unset user.name"},
		{"change-config", "git config -e"},
		{"change-config", "git config --file x.cfg a.b c"},
	}
	for _, tt := range cases {
		t.Run(tt.command, func(t *testing.T) {
			checker, _ := aChecker(aSet("git", "abcdef1", `{"git":{"deny":["`+tt.action+`"]}}`))
			refusedAs(t, checker, aShellCall(tt.command), "Refused by the guard: git.deny "+tt.action+", in git @ abcdef1.")
		})
	}
}

func TestAGitCommandWithoutADeniedActionRuns(t *testing.T) {
	all := `{"git":{"deny":["push","force-push","skip-hooks","rewrite-history","delete-branch","change-remote","change-config"]}}`
	for _, command := range []string{
		"git status",
		"git log --oneline -5",
		"git commit -m 'no -n here'",
		`git commit -m "$MSG"`,
		"git commit -am x",
		"git reset HEAD a.txt",
		"git branch -a",
		"git remote -v",
		"git config user.name",
		"git config --get user.name",
		"git config --list",
		"git config get user.name",
		"git -c color.ui=never diff",
		`git add "$FILE"`,
		"git fetch origin",
	} {
		t.Run(command, func(t *testing.T) {
			checker, _ := aChecker(aSet("git", "abcdef1", all))
			allowed(t, checker, aShellCall(command))
		})
	}
}

func TestAPushIsNoForcePush(t *testing.T) {
	checker, _ := aChecker(aSet("git", "abcdef1", `{"git":{"deny":["force-push","delete-branch"]}}`))

	allowed(t, checker, aShellCall("git push -u origin main"))
}

func TestAGitAliasIsResolved(t *testing.T) {
	checker, _ := aChecker(aSet("git", "abcdef1", `{"git":{"deny":["push"]}}`))

	refusedAs(t, checker, aShellCall("git -c alias.ship=push ship origin"), "Refused by the guard: git.deny push, in git @ abcdef1.")
	refusedAs(t, checker, aShellCall("git -c 'alias.ship=!git push' ship"), "Refused by the guard: git.deny push, in git @ abcdef1.")
}

func TestAGitCommandTheGuardDoesNotKnowIsUnresolvableUnderGitRules(t *testing.T) {
	checker, _ := aChecker(aSet("git", "abcdef1", `{"git":{"deny":["push"]}}`))

	refusedAs(t, checker, aShellCall("git ship"), "Refused by the guard: unresolvable: git ship.")
}

func TestAGitCommandTheGuardDoesNotKnowRunsWithoutGitRules(t *testing.T) {
	checker, _ := aChecker(aSet("tools", "abcdef1", `{"tools":{"deny":["web"]}}`))

	allowed(t, checker, aShellCall("git ship"))
}

func TestTheGitBypassesAreClosed(t *testing.T) {
	skipHooks := "Refused by the guard: git.deny skip-hooks, in rules @ abcdef1."
	runBypasses(t, `{"git":{"deny":["push","skip-hooks"]}}`, []bypass{
		{"--no-verify", "git commit --no-verify -m x", skipHooks},
		{"git -c core.hooksPath=", "git -c core.hooksPath=/dev/null commit -m x", skipHooks},
		{"git -c core.hooksPath in another case", "git -c CORE.HOOKSPATH=/dev/null commit -m x", skipHooks},
		{"git --config-env core.hooksPath", "git --config-env=core.hooksPath=HOOKS commit -m x", skipHooks},
		{"GIT_CONFIG_KEY as a prefix", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x", skipHooks},
		{"GIT_CONFIG_KEY exported before", "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x; git commit -m x", skipHooks},
		{"GIT_CONFIG_KEY through env", "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git commit -m x", skipHooks},
		{"GIT_CONFIG_PARAMETERS", `GIT_CONFIG_PARAMETERS="'core.hooksPath'='/x'" git commit -m x`, skipHooks},
		{"GIT_CONFIG_PARAMETERS built at run time", `GIT_CONFIG_PARAMETERS="$P" git commit -m x`, `Refused by the guard: unresolvable: GIT_CONFIG_PARAMETERS="$P" for git.`},
		{"GIT_CONFIG_KEY built at run time", `export GIT_CONFIG_KEY_0="$K"; git commit -m x`, `Refused by the guard: unresolvable: GIT_CONFIG_KEY_0="$K" for git.`},
		{"a git configuration file the guard cannot read", "GIT_CONFIG_GLOBAL=/tmp/g git commit -m x", "Refused by the guard: unresolvable: GIT_CONFIG_GLOBAL=/tmp/g for git."},
		{"another git exec path", "GIT_EXEC_PATH=/tmp/x git commit -m x", "Refused by the guard: unresolvable: GIT_EXEC_PATH=/tmp/x for git."},
		{"a flag from a variable", "git commit $FLAGS -m x", "Refused by the guard: unresolvable: argument $FLAGS of git commit."},
		{"a subcommand from a variable", `git "$SUB"`, `Refused by the guard: unresolvable: git subcommand "$SUB".`},
		{"a refspec from a variable", `git push origin "$REF"`, "Refused by the guard: git.deny push, in rules @ abcdef1."},
		{"a global option from a variable", `git "$OPT" push`, `Refused by the guard: unresolvable: git subcommand "$OPT".`},
		{"a -c pair from a variable", `git -c "$PAIR" commit -m x`, `Refused by the guard: unresolvable: argument "$PAIR" of git.`},
		{"git in sh -c", `sh -c 'git push'`, "Refused by the guard: git.deny push, in rules @ abcdef1."},
		{"git in eval", `eval git push`, "Refused by the guard: git.deny push, in rules @ abcdef1."},
	})
}
