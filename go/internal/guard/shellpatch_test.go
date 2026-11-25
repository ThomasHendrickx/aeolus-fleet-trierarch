package guard

import "testing"

func TestShellPatchChecksEveryWriteAgainstTheBoundaryAndProtectedPaths(t *testing.T) {
	checker, _ := aChecker()
	checker.Harness = "codex"
	checker.Protected = CodexProtected(home+"/.codex", stateDir, configFile, shipFolder, repository)
	for _, example := range []struct {
		name, target, reason string
	}{
		{"workspace hooks", ".codex/hooks.json", "protected: " + repository + "/.codex/hooks.json"},
		{"Codex home config", home + "/.codex/config.toml", "protected: " + home + "/.codex/config.toml"},
		{"outside the ship", home + "/notes.txt", "outside the boundary: " + home + "/notes.txt"},
	} {
		t.Run(example.name, func(t *testing.T) {
			command := "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: allowed.txt\n+hello\n" +
				"*** Add File: " + example.target + "\n+hello\n*** End Patch\nEOF"
			refusedAs(t, checker, aShellCall(command), "Refused by the guard: "+example.reason+".")
		})
	}
}

func TestShellPatchChecksARenameDestination(t *testing.T) {
	checker, _ := aChecker()
	checker.Harness = "codex"
	checker.Protected = CodexProtected(home+"/.codex", stateDir, configFile, shipFolder, repository)
	command := `apply_patch '*** Begin Patch
*** Update File: notes.txt
*** Move to: .codex/hooks.json
@@
-old
+new
*** End Patch'`
	refusedAs(t, checker, aShellCall(command), "Refused by the guard: protected: "+repository+"/.codex/hooks.json.")
}

func TestShellPatchAllowsALiteralWriteInsideTheBoundary(t *testing.T) {
	checker, _ := aChecker(aSet("rules", "abcdef1", `{}`))
	checker.Harness = "codex"
	command := `apply_patch <<'EOF'
*** Begin Patch
*** Add File: notes.txt
+hello
*** End Patch
EOF`
	allowed(t, checker, aShellCall(command))
}

func TestShellPatchRequiresLiteralInputWhileRulesApply(t *testing.T) {
	checker, _ := aChecker(aSet("rules", "abcdef1", `{}`))
	checker.Harness = "codex"
	refusedAs(t, checker, aShellCall("apply_patch < changes.patch"), "Refused by the guard: unresolvable: apply_patch input.")
}
