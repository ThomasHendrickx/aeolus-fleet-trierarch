package permissions

import (
	"path/filepath"
	"strings"
)

// Answer is the owner's choice in a question reply.
type Answer struct {
	QuestionID string `json:"questionId"`
	Option     int    `json:"option"`
	Note       string `json:"note"`
}

// PermissionRule names the exact action Claude Code may repeat in this process.
type PermissionRule struct {
	ToolName    string `json:"toolName"`
	RuleContent string `json:"ruleContent,omitempty"`
}

// PermissionUpdate adds a rule to this Claude Code process only.
type PermissionUpdate struct {
	Type        string           `json:"type"`
	Rules       []PermissionRule `json:"rules"`
	Behavior    string           `json:"behavior"`
	Destination string           `json:"destination"`
}

func (r Request) decision(answer Answer) Decision {
	if answer.Option == 1 || answer.Option == 2 {
		result := Decision{Behavior: "allow", UpdatedInput: r.Input}
		if answer.Option == 2 {
			result.UpdatedPermissions = []PermissionUpdate{{Type: "addRules", Rules: []PermissionRule{{ToolName: r.ruleTool(), RuleContent: r.sessionRule()}}, Behavior: "allow", Destination: "session"}}
		}
		return result
	}
	note := answer.Note
	if note == "" {
		note = "The owner denied it."
	}
	return Decision{Behavior: "deny", Message: note}
}

// Claude Code distinguishes a filesystem-absolute rule (//path) from a
// settings-relative rule (/path). Never turn an exact path into a glob.
func (r Request) sessionRule() string {
	action := r.action()
	if r.Tool == "Bash" {
		// Claude Code reads a * in a Bash rule as a wildcard and \* as a
		// literal star, and treats a backslash as an escape only in a rule
		// with a star; a rule without one is matched exactly.
		if !strings.Contains(action, "*") {
			return action
		}
		return strings.NewReplacer("\\", "\\\\", "*", "\\*").Replace(action)
	}
	action = strings.NewReplacer("\\", "\\\\", "[", "\\[", "]", "\\]", "*", "\\*", "?", "[\\x3f]", "(", "\\(", ")", "\\)", "|", "\\|", "+", "\\+", "^", "\\^", "$", "\\$").Replace(action)
	if filepath.IsAbs(action) {
		return "/" + action
	}
	return action
}

func (r Request) ruleTool() string {
	switch r.Tool {
	case "Write", "MultiEdit", "NotebookEdit":
		return "Edit"
	}
	return r.Tool
}
