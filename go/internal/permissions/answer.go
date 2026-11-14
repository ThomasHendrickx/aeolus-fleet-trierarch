package permissions

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
			result.UpdatedPermissions = []PermissionUpdate{{Type: "addRules", Rules: []PermissionRule{{ToolName: r.Tool, RuleContent: r.action()}}, Behavior: "allow", Destination: "session"}}
		}
		return result
	}
	note := answer.Note
	if note == "" {
		note = "The owner denied it."
	}
	return Decision{Behavior: "deny", Message: note}
}
