package permissions

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestTheOwnersAnswerBecomesThePermissionResult(t *testing.T) {
	for _, test := range []struct{ name, tool, input, answer, want string }{
		{"allow once", "Bash", `{"command":"npm install"}`, `{"option":1}`, `{"behavior":"allow","updatedInput":{"command":"npm install"}}`},
		{"session exact command", "Bash", `{"command":"date +%Y > year.txt"}`, `{"option":2}`, `{"behavior":"allow","updatedInput":{"command":"date +%Y > year.txt"},"updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"date +%Y > year.txt"}],"behavior":"allow","destination":"session"}]}`},
		{"session exact path", "Edit", `{"file_path":"/work/a.ts"}`, `{"option":2}`, `{"behavior":"allow","updatedInput":{"file_path":"/work/a.ts"},"updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Edit","ruleContent":"/work/a.ts"}],"behavior":"allow","destination":"session"}]}`},
		{"session tool", "Search", `{"query":"ship"}`, `{"option":2}`, `{"behavior":"allow","updatedInput":{"query":"ship"},"updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Search"}],"behavior":"allow","destination":"session"}]}`},
		{"deny", "Bash", `{}`, `{"option":3}`, `{"behavior":"deny","message":"The owner denied it."}`},
		{"deny with note", "Bash", `{}`, `{"option":3,"note":"Use npm ci."}`, `{"behavior":"deny","message":"Use npm ci."}`},
		{"note alone", "Bash", `{}`, `{"note":"Explain first."}`, `{"behavior":"deny","message":"Explain first."}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			var answer Answer
			if err := json.Unmarshal([]byte(test.answer), &answer); err != nil {
				t.Fatal(err)
			}
			got, err := json.Marshal((Request{Tool: test.tool, Input: json.RawMessage(test.input)}).decision(answer))
			if err != nil {
				t.Fatal(err)
			}
			var actual, expected any
			_ = json.Unmarshal(got, &actual)
			_ = json.Unmarshal([]byte(test.want), &expected)
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("decision = %s, want %s", got, test.want)
			}
		})
	}
}
