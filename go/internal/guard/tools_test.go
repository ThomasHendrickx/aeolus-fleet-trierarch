package guard

import "testing"

func TestEachClaudeCodeToolIsCheckedAsItsKind(t *testing.T) {
	tests := []struct {
		tool  string
		input map[string]any
		kind  string
	}{
		{"Bash", map[string]any{"command": "ls"}, "shell"},
		{"BashOutput", map[string]any{"bash_id": "1"}, "shell"},
		{"KillShell", map[string]any{"shell_id": "1"}, "shell"},
		{"Write", map[string]any{"file_path": repository + "/a.txt", "content": "x"}, "file-write"},
		{"Edit", map[string]any{"file_path": repository + "/a.txt"}, "file-write"},
		{"MultiEdit", map[string]any{"file_path": repository + "/a.txt"}, "file-write"},
		{"NotebookEdit", map[string]any{"notebook_path": repository + "/a.ipynb"}, "file-write"},
		{"Read", map[string]any{"file_path": repository + "/a.txt"}, "file-read"},
		{"Glob", map[string]any{"pattern": "**"}, "file-read"},
		{"Grep", map[string]any{"pattern": "x"}, "file-read"},
		{"LS", map[string]any{"path": repository}, "file-read"},
		{"NotebookRead", map[string]any{"notebook_path": repository + "/a.ipynb"}, "file-read"},
		{"WebFetch", map[string]any{"url": "https://example.com"}, "web"},
		{"WebSearch", map[string]any{"query": "x"}, "web"},
		{"Task", map[string]any{"prompt": "x"}, "agent"},
		{"Agent", map[string]any{"prompt": "x"}, "agent"},
		{"mcp__linear__create_issue", map[string]any{}, "mcp:linear/create_issue"},
	}
	for _, tt := range tests {
		t.Run(tt.tool, func(t *testing.T) {
			checker, _ := aChecker(aSet("deny", "abcdef1", `{"tools":{"deny":["`+tt.kind+`"]}}`))
			refusedAs(t, checker, aCall(tt.tool, tt.input), "Refused by the guard: tools.deny "+tt.kind+", in deny @ abcdef1.")
		})
	}
}

func TestAToolDenyMatchesMCPToolsByGlob(t *testing.T) {
	checker, _ := aChecker(aSet("no-linear", "abcdef1", `{"tools":{"deny":["mcp:linear/*"]}}`))

	refusedAs(t, checker, aCall("mcp__linear__create_issue", map[string]any{}), "Refused by the guard: tools.deny mcp:linear/*, in no-linear @ abcdef1.")
	allowed(t, checker, aCall("mcp__github__create_issue", map[string]any{}))
}

func TestAToolAllowListLetsOnlyItsTools(t *testing.T) {
	checker, _ := aChecker(aSet("shell-only", "abcdef1", `{"tools":{"allow":["shell","mcp:github/*"]}}`))

	allowed(t, checker, aShellCall("ls"))
	allowed(t, checker, aCall("mcp__github__get_issue", map[string]any{}))
	refusedAs(t, checker, aCall("WebFetch", map[string]any{"url": "https://example.com"}), "Refused by the guard: tools.allow lacks web, in shell-only @ abcdef1.")
}

func TestAnEmptyToolAllowListLetsEveryTool(t *testing.T) {
	checker, _ := aChecker(aSet("empty", "abcdef1", `{"tools":{"allow":[],"deny":[]}}`))

	allowed(t, checker, aCall("WebFetch", map[string]any{"url": "https://example.com"}))
}

func TestAnUnknownToolIsRefusedWhileAnySetApplies(t *testing.T) {
	checker, _ := aChecker(aSet("empty", "abcdef1", `{}`))

	refusedAs(t, checker, aCall("Teleport", map[string]any{}), "Refused by the guard: unknown tool: Teleport.")
}

func TestAnUnknownToolRunsWithoutRuleSets(t *testing.T) {
	checker, _ := aChecker()

	allowed(t, checker, aCall("Teleport", map[string]any{}))
}

func TestEverySetRefusesOnItsOwn(t *testing.T) {
	checker, _ := aChecker(
		aSet("floor", "1111111", `{"tools":{"deny":["agent"]}}`),
		aSet("chosen", "2222222", `{"tools":{"deny":["web"]}}`),
	)

	refusedAs(t, checker, aCall("Task", map[string]any{"prompt": "x"}), "Refused by the guard: tools.deny agent, in floor @ 1111111.")
	refusedAs(t, checker, aCall("WebSearch", map[string]any{"query": "x"}), "Refused by the guard: tools.deny web, in chosen @ 2222222.")
}

func TestAChosenSetCannotLoosenTheFloor(t *testing.T) {
	checker, _ := aChecker(
		aSet("floor", "1111111", `{"tools":{"deny":["web"]}}`),
		aSet("chosen", "2222222", `{"tools":{"allow":["web","shell"]}}`),
	)

	refusedAs(t, checker, aCall("WebFetch", map[string]any{"url": "https://example.com"}), "Refused by the guard: tools.deny web, in floor @ 1111111.")
}
