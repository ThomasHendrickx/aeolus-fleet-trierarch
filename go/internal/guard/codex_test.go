package guard

import (
	"testing"
)

func TestACodexToolIsCheckedAgainstItsKind(t *testing.T) {
	for _, tool := range []struct {
		name, kind, input string
	}{
		{"Bash", "shell", `{"command":"echo hello"}`},
		{"apply_patch", "file-write", `{"command":"*** Begin Patch\n*** Add File: notes.txt\n+hello\n*** End Patch"}`},
		{"view_image", "file-read", `{"path":"notes.png"}`},
		{"webrun", "web", `{"search_query":[{"q":"hello"}]}`},
		{"collaborationspawn_agent", "agent", `{}`},
		{"collaborationfollowup_task", "agent", `{}`},
		{"collaborationsend_message", "agent", `{}`},
		{"mcp__example__read", "mcp:example/read", `{}`},
		{"read_mcp_resource", "mcp:example/*", `{"server":"example","uri":"test://notes"}`},
		{"list_mcp_resources", "mcp:example/*", `{"server":"example"}`},
		{"list_mcp_resource_templates", "mcp:example/*", `{"server":"example"}`},
	} {
		t.Run(tool.name, func(t *testing.T) {
			checker, _ := aChecker(aSet("rules", "abcdef1", `{"tools":{"deny":["`+tool.kind+`"]}}`))
			checker.Harness = "codex"
			refusedAs(t, checker, aCodexCall(tool.name, tool.input), "Refused by the guard: tools.deny "+tool.kind+", in rules @ abcdef1.")
		})
	}
}

func TestACodexPatchChecksEachWritePath(t *testing.T) {
	for _, line := range []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "} {
		t.Run(line, func(t *testing.T) {
			checker, _ := aChecker()
			checker.Harness = "codex"
			checker.Protected = CodexProtected(home+"/.codex", stateDir, configFile, shipFolder, repository)
			patch := "*** Begin Patch\n"
			if line == "*** Move to: " {
				patch += "*** Update File: notes.txt\n"
			}
			patch += line + ".codex/hooks.json\n*** End Patch"
			refusedAs(t, checker, aCall("apply_patch", map[string]any{"command": patch}), "Refused by the guard: protected: "+repository+"/.codex/hooks.json.")
		})
	}
}

func TestCodexProtectsItsEffectiveHomeAndWorkspaceSettingsEvenWithoutRules(t *testing.T) {
	checker, _ := aChecker()
	checker.Harness = "codex"
	codexHome := home + "/codex-home"
	checker.Protected = CodexProtected(codexHome, stateDir, configFile, shipFolder, repository)
	for _, target := range []string{
		codexHome + "/config.toml",
		codexHome + "/work.config.toml",
		codexHome + "/hooks.json",
		codexHome + "/rules/guard.rules",
		repository + "/nested/.codex",
		repository + "/nested/.codex/hooks.json",
		stateDir + "/rules.json",
		configFile,
	} {
		t.Run(target, func(t *testing.T) {
			refusedAs(t, checker, aShellCall("touch "+target), "Refused by the guard: protected: "+target+".")
		})
	}
}

func TestOnlyTheNamedCodexInternalToolsIgnoreToolRules(t *testing.T) {
	checker, _ := aChecker(aSet("rules", "abcdef1", `{"tools":{"deny":["*"]}}`))
	checker.Harness = "codex"
	for _, tool := range []string{
		"collaborationwait_agent", "collaborationlist_agents", "collaborationinterrupt_agent",
		"create_goal", "update_goal", "get_goal", "update_plan", "clock__curr_time",
	} {
		t.Run(tool, func(t *testing.T) { allowed(t, checker, aCodexCall(tool, "{}")) })
	}
	refusedAs(t, checker, aCodexCall("request_plugin_install", "{}"), "Refused by the guard: unknown tool: request_plugin_install.")
	refusedAs(t, checker, aCodexCall("image_gen__imagegen", "{}"), "Refused by the guard: unknown tool: image_gen__imagegen.")
}

func TestCodexListsAllMCPResourcesOnlyWithoutAnMCPRestriction(t *testing.T) {
	for _, tool := range []string{"list_mcp_resources", "list_mcp_resource_templates"} {
		t.Run(tool, func(t *testing.T) {
			for _, rules := range []string{`{"tools":{"deny":["mcp:calendar/read"]}}`, `{"tools":{"allow":["mcp:calendar/*"]}}`, `{"tools":{"deny":["*"]}}`} {
				checker, _ := aChecker(aSet("rules", "abcdef1", rules))
				checker.Harness = "codex"
				if answer := check(t, checker, aCodexCall(tool, "{}")); answer.ExitCode != 2 {
					t.Fatalf("listing every server under %s = %+v, want refusal", rules, answer)
				}
			}
			checker, _ := aChecker(aSet("rules", "abcdef1", `{"tools":{"deny":["web"]}}`))
			checker.Harness = "codex"
			allowed(t, checker, aCodexCall(tool, "{}"))
		})
	}
}

func TestACodexResourceReadRequiresAServer(t *testing.T) {
	checker, _ := aChecker()
	checker.Harness = "codex"
	refusedAs(t, checker, aCodexCall("read_mcp_resource", `{"uri":"test://notes"}`), "Refused by the guard: guard failed: input unreadable.")
}

func aCodexCall(tool, input string) string {
	return `{"cwd":"` + repository + `","tool_name":"` + tool + `","tool_input":` + input + `}`
}

func TestEveryHarnessProtectsAgainstStartingAnotherHarnessWithRules(t *testing.T) {
	for _, harness := range []string{"claude-code", "codex"} {
		t.Run(harness, func(t *testing.T) {
			for _, command := range []string{"codex --version", "claude --version", "copilot --version", "cursor-agent --version", "agent --version", "/usr/local/bin/codex --version"} {
				t.Run(command, func(t *testing.T) {
					checker, _ := aChecker(aSet("rules", "abcdef1", `{}`))
					checker.Harness = harness
					refusedAs(t, checker, aShellCall(command), "Refused by the guard: protected: harness.")
					withoutRules, _ := aChecker()
					withoutRules.Harness = harness
					allowed(t, withoutRules, aShellCall(command))
				})
			}
		})
	}
}

func TestAnInterpreterNeedsALiteralProgramAndCannotStartInteractiveWithRules(t *testing.T) {
	checker, _ := aChecker(aSet("rules", "abcdef1", `{}`))
	for _, command := range []string{
		"bash", "bash --norc -i", "bash -ic 'echo hello'", "dash", "zsh",
		"python", "python3.12 -i ./example.py", "node", "node --interactive ./example.js",
		"ruby", "perl", "cat notes.txt | python3", "python3 | cat", "node -", "python3 -u",
	} {
		t.Run(command, func(t *testing.T) {
			refusedAs(t, checker, aShellCall(command), "Refused by the guard: unresolvable: reads commands from stdin.")
		})
	}
	for _, command := range []string{"bash ./script.sh", "bash -c 'echo hello'", "python3 -u ./example.py", "node -e '0'", "ruby ./example.rb", "perl ./example.pl"} {
		t.Run(command, func(t *testing.T) {
			allowed(t, checker, aShellCall(command))
		})
	}
}
