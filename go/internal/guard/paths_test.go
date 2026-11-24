package guard

import "testing"

func aWrite(path string) string {
	return aCall("Write", map[string]any{"file_path": path, "content": "x"})
}

func TestAWriteInsideTheShipsFolderRuns(t *testing.T) {
	checker, _ := aChecker()

	allowed(t, checker, aWrite(repository+"/docs/a.md"))
	allowed(t, checker, aWrite(shipFolder+"/notes.txt"))
	allowed(t, checker, aCall("Edit", map[string]any{"file_path": "docs/a.md"}))
	allowed(t, checker, aShellCall("echo x > a.txt 2>/dev/null && ls >&2 && touch b.txt"))
}

func TestAWriteOutsideTheBoundaryIsRefusedWithoutRuleSetsToo(t *testing.T) {
	checker, _ := aChecker()

	refusedAs(t, checker, aWrite("/etc/hosts"), "Refused by the guard: outside the boundary: /etc/hosts.")
	refusedAs(t, checker, aShellCall("echo x > /tmp/x"), "Refused by the guard: outside the boundary: /tmp/x.")
}

func TestEveryWriteTargetIsChecked(t *testing.T) {
	tests := []struct{ command, target string }{
		{"echo x > /tmp/a", "/tmp/a"},
		{"echo x >> /tmp/a", "/tmp/a"},
		{"echo x >| /tmp/a", "/tmp/a"},
		{"echo x &> /tmp/a", "/tmp/a"},
		{"echo x 2> /tmp/a", "/tmp/a"},
		{"echo x >& /tmp/a", "/tmp/a"},
		{"cat <> /tmp/a", "/tmp/a"},
		{"cp a.txt /tmp/b", "/tmp/b"},
		{"cp -t /tmp a.txt", "/tmp/a.txt"},
		{"mv /tmp/a b.txt", "/tmp/a"},
		{"mv a.txt /tmp/", "/tmp/a.txt"},
		{"rm -rf /tmp/a", "/tmp/a"},
		{"rmdir /tmp/a", "/tmp/a"},
		{"touch /tmp/a", "/tmp/a"},
		{"mkdir -p /tmp/a", "/tmp/a"},
		{"ln -s a.txt /tmp/l", "/tmp/l"},
		{"echo x | tee -a /tmp/a", "/tmp/a"},
		{"sed -i s/a/b/ /tmp/a", "/tmp/a"},
		{"sed -i.bak -e s/a/b/ /tmp/a", "/tmp/a"},
		{"chmod +x /tmp/a", "/tmp/a"},
		{"rm /tmp/*.log", "/tmp"},
		{"touch ~/a", home + "/a"},
		{"touch $HOME/a", home + "/a"},
		{"D=/tmp; touch $D/a", "/tmp/a"},
	}
	for _, tt := range tests {
		t.Run(tt.command, func(t *testing.T) {
			checker, _ := aChecker()
			refusedAs(t, checker, aShellCall(tt.command), "Refused by the guard: outside the boundary: "+tt.target+".")
		})
	}
}

func TestReadsAndCopiesFromOutsideRun(t *testing.T) {
	checker, _ := aChecker()

	allowed(t, checker, aShellCall("cp /etc/hosts a.txt && cat /etc/hosts > b.txt && sed s/a/b/ /etc/hosts"))
}

func TestTheGuardsOwnFilesAndTheHarnessSettingsAreProtected(t *testing.T) {
	tests := []struct{ call, path string }{
		{aWrite(home + "/.claude/settings.json"), home + "/.claude/settings.json"},
		{aCall("Edit", map[string]any{"file_path": repository + "/.claude/settings.local.json"}), repository + "/.claude/settings.local.json"},
		{aCall("MultiEdit", map[string]any{"file_path": shipFolder + "/.claude/settings.json"}), shipFolder + "/.claude/settings.json"},
		{aWrite(stateDir + "/rules.json"), stateDir + "/rules.json"},
		{aWrite(configFile), configFile},
		{aShellCall("echo '{}' > ~/.claude/settings.json"), home + "/.claude/settings.json"},
		{aShellCall("rm -rf ~/.claude"), home + "/.claude"},
		{aShellCall("rm -rf ~"), home},
		{aShellCall("rm -rf .claude"), repository + "/.claude"},
		{aShellCall("mv ~/.claude/settings.json x"), home + "/.claude/settings.json"},
		{aShellCall("cp evil.json ~/.claude/settings.json"), home + "/.claude/settings.json"},
		{aShellCall("cp settings.json ~/.claude/"), home + "/.claude/settings.json"},
		{aShellCall("sed -i s/a/b/ " + stateDir + "/refusals.jsonl"), stateDir + "/refusals.jsonl"},
		{aShellCall("rm -rf " + shipFolder), shipFolder},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			checker, _ := aChecker()
			refusedAs(t, checker, tt.call, "Refused by the guard: protected: "+tt.path+".")
		})
	}
}

func TestAWriteTargetThatCannotBeResolvedIsRefusedWhileAnySetApplies(t *testing.T) {
	checker, _ := aChecker(aSet("empty", "abcdef1", `{}`))

	refusedAs(t, checker, aShellCall(`echo x > "$OUT"`), `Refused by the guard: unresolvable: write target "$OUT".`)
	refusedAs(t, checker, aShellCall(`cd "$DIR" && touch a`), `Refused by the guard: unresolvable: write target a in an unknown working folder.`)
}

func TestAWriteTargetThatCannotBeResolvedRunsWithoutRuleSets(t *testing.T) {
	checker, _ := aChecker()

	allowed(t, checker, aShellCall(`echo x > "$OUT"`))
}

func TestWritePathsNarrowTheBoundaryRelativeToTheRepositories(t *testing.T) {
	checker, _ := aChecker(aSet("docs", "abcdef1", `{"writePaths":{"allow":["docs/**"],"deny":["**/.github/**"]}}`))

	allowed(t, checker, aWrite(repository+"/docs/a/b.md"))
	refusedAs(t, checker, aWrite(repository+"/src/a.go"), "Refused by the guard: writePaths.allow lacks src/a.go, in docs @ abcdef1.")
	refusedAs(t, checker, aWrite(repository+"/docs/.github/x.yml"), "Refused by the guard: writePaths.deny **/.github/**, in docs @ abcdef1.")
	refusedAs(t, checker, aWrite(shipFolder+"/notes.txt"), "Refused by the guard: writePaths.allow lacks "+shipFolder+"/notes.txt, in docs @ abcdef1.")
	refusedAs(t, checker, aShellCall("cd docs && rm -rf ../.github"), "Refused by the guard: writePaths.deny **/.github/**, in docs @ abcdef1.")
}

func TestAWritePathsDenyAloneLetsTheRestOfTheBoundary(t *testing.T) {
	checker, _ := aChecker(aSet("no-ci", "abcdef1", `{"writePaths":{"deny":[".github/**"]}}`))

	allowed(t, checker, aWrite(shipFolder+"/notes.txt"))
	refusedAs(t, checker, aWrite(repository+"/.github/workflows/ci.yml"), "Refused by the guard: writePaths.deny .github/**, in no-ci @ abcdef1.")
}

func TestThePathBypassesAreClosed(t *testing.T) {
	links := memoryLinks{
		repository + "/out":      "/etc",
		repository + "/settings": home + "/.claude/settings.json",
		repository + "/rel":      "../../../../../../tmp",
	}
	tests := []struct{ name, call, want string }{
		{"..", aWrite(repository + "/../../../../etc/hosts"), "Refused by the guard: outside the boundary: /home/crew/etc/hosts."},
		{".. in the shell", aShellCall("touch ../../../../x"), "Refused by the guard: outside the boundary: /home/crew/x."},
		{"a symlink out of the boundary", aShellCall("echo x > out/passwd"), "Refused by the guard: outside the boundary: /etc/passwd."},
		{"a symlink to a protected file", aWrite(repository + "/settings"), "Refused by the guard: protected: " + home + "/.claude/settings.json."},
		{"a relative symlink", aWrite(repository + "/rel/x"), "Refused by the guard: outside the boundary: /tmp/x."},
		{"a symlink made in the same call", aShellCall("ln -sT /etc l && echo x > l/passwd"), "Refused by the guard: outside the boundary: /etc/passwd."},
		{"a symlink to a protected file made in the same call", aShellCall("ln -sf ~/.claude/settings.json s; echo '{}' > s"), "Refused by the guard: protected: " + home + "/.claude/settings.json."},
		{"cd before a relative path", aShellCall("cd /tmp && echo x > a"), "Refused by the guard: outside the boundary: /tmp/a."},
		{"cd up before a relative path", aShellCall("cd ../../../.. && touch x"), "Refused by the guard: outside the boundary: /home/crew/x."},
		{"cd in a subshell does not leak", aShellCall("(cd /tmp); echo x > /tmp/a"), "Refused by the guard: outside the boundary: /tmp/a."},
		{"a variable path", aShellCall("D=/tmp; echo x > $D/a"), "Refused by the guard: outside the boundary: /tmp/a."},
		{"a write in sh -c", aShellCall("sh -c 'echo x > /tmp/a'"), "Refused by the guard: outside the boundary: /tmp/a."},
		{"a write in eval", aShellCall("eval 'touch /tmp/a'"), "Refused by the guard: outside the boundary: /tmp/a."},
		{"a write through a file tool", aCall("NotebookEdit", map[string]any{"notebook_path": "/tmp/a.ipynb"}), "Refused by the guard: outside the boundary: /tmp/a.ipynb."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			checker, _ := aChecker()
			checker.Links = links
			refusedAs(t, checker, tt.call, tt.want)
		})
	}
}

func TestTheMCPToolBypassIsClosed(t *testing.T) {
	checker, _ := aChecker(aSet("no-fs", "abcdef1", `{"tools":{"deny":["mcp:filesystem/*"]}}`))

	refusedAs(t, checker, aCall("mcp__filesystem__write_file", map[string]any{"path": "/tmp/a"}), "Refused by the guard: tools.deny mcp:filesystem/*, in no-fs @ abcdef1.")
}

func TestASymlinkLoopFailsClosed(t *testing.T) {
	checker, _ := aChecker()
	checker.Links = memoryLinks{repository + "/a": repository + "/b", repository + "/b": repository + "/a"}

	refusedAs(t, checker, aWrite(repository+"/a/x"), "Refused by the guard: guard failed: symbolic link loop.")
}
