package guardrules

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func aResolvedSet(rules string) string {
	return `{"name":"no-push","repository":"fleet/rules","commit":"8d41e079bd56801e1e2acf18f094c22ade5ec8a9","file":"guards/no-push.yaml","floor":true,"rules":` + rules + `}`
}

func withSets(version int, sets ...string) string {
	return strings.Replace(anAssignment(version), `"sets":[]`, `"sets":[`+strings.Join(sets, ",")+`]`, 1)
}

func TestRulesCarryTheInnerBlockWithAllFourRuleKinds(t *testing.T) {
	rules := `{"commands":{"deny":[{"command":"npm","args":["publish"]},{"command":"curl"}],"allow":[]},"git":{"deny":["push","force-push","skip-hooks","rewrite-history","delete-branch","change-remote","change-config"]},"writePaths":{"allow":["docs/**"],"deny":["**/.github/**"]},"tools":{"allow":["shell","file-write","file-read","web","agent","mcp:linear/*"],"deny":["mcp:*/delete*"]}}`
	got, err := Read(withSets(1, aResolvedSet(rules)), configured)
	if err != nil || len(got.Sets) != 1 {
		t.Fatalf("Read(four rule kinds) = %+v, %v, want the complete resolution", got, err)
	}
	var set struct {
		Name, Repository, Commit, File string
		Floor                          bool
		Rules                          json.RawMessage
	}
	if err := json.Unmarshal(got.Sets[0], &set); err != nil {
		t.Fatal(err)
	}
	if set.Name != "no-push" || set.Repository != "fleet/rules" || set.Commit != "8d41e079bd56801e1e2acf18f094c22ade5ec8a9" || set.File != "guards/no-push.yaml" || !set.Floor {
		t.Fatalf("resolved set = %+v, want the pinned floor metadata", set)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(set.Rules, &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 4 {
		t.Fatalf("rules = %s, want all four rule kinds", set.Rules)
	}
}

func TestAnEmptyInnerBlockAndOptionalRuleListsAreValid(t *testing.T) {
	for _, rules := range []string{`{}`, `{"commands":{},"git":{},"writePaths":{},"tools":{}}`, `{"commands":{"allow":[{"command":"git","args":[]}]}}`} {
		if _, err := Read(withSets(1, aResolvedSet(rules)), configured); err != nil {
			t.Fatalf("Read(rules %s) = %v, want valid", rules, err)
		}
	}
}

func TestResolvedSetsRequireEveryMetadataFieldAndTheInnerRulesBlock(t *testing.T) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(aResolvedSet(`{}`)), &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"name", "repository", "commit", "file", "floor", "rules"} {
		for _, replacement := range []string{"missing", "null"} {
			t.Run(field+" "+replacement, func(t *testing.T) {
				copy := make(map[string]json.RawMessage)
				for key, value := range fields {
					copy[key] = value
				}
				if replacement == "missing" {
					delete(copy, field)
				} else {
					copy[field] = json.RawMessage(`null`)
				}
				text, _ := json.Marshal(copy)
				if _, err := Read(withSets(1, string(text)), configured); !errors.Is(err, ErrRefused) {
					t.Fatalf("Read(%s %s) = %v, want refusal", field, replacement, err)
				}
			})
		}
	}
	for _, test := range []struct{ name, old, replacement string }{
		{"empty name", `"name":"no-push"`, `"name":""`},
		{"name is a path", `"name":"no-push"`, `"name":"../no-push"`},
		{"name starts with dot", `"name":"no-push"`, `"name":".no-push"`},
		{"name too long", `"name":"no-push"`, `"name":"` + strings.Repeat("a", 101) + `"`},
		{"empty repository", `"repository":"fleet/rules"`, `"repository":""`},
		{"empty commit", `"commit":"8d41e079bd56801e1e2acf18f094c22ade5ec8a9"`, `"commit":""`},
		{"empty file", `"file":"guards/no-push.yaml"`, `"file":""`},
		{"floor is not boolean", `"floor":true`, `"floor":"true"`},
		{"description does not travel", `"floor":true`, `"floor":true,"description":"not in the message"`},
		{"unknown case variant", `"floor":true`, `"Floor":true`},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload := withSets(1, strings.Replace(aResolvedSet(`{}`), test.old, test.replacement, 1))
			if _, err := Read(payload, configured); !errors.Is(err, ErrRefused) {
				t.Fatalf("Read(%s) = %v, want refusal", test.name, err)
			}
		})
	}
	for _, set := range []string{`null`, `1`, `[]`, `"set"`} {
		if _, err := Read(withSets(1, set), configured); !errors.Is(err, ErrRefused) {
			t.Fatalf("Read(set %s) = %v, want refusal", set, err)
		}
	}
}

func TestRulesRefuseUnknownFieldsAndInvalidNestedValues(t *testing.T) {
	for _, rules := range []string{
		`null`, `[]`, `"rules"`, `{"name":"no-push","rules":{}}`, `{"description":"not sent"}`, `{"unknown":{}}`,
		`{"Commands":{}}`, `{"commands":null}`, `{"git":null}`, `{"writePaths":null}`, `{"tools":null}`,
		`{"commands":{"other":[]}}`, `{"commands":{"allow":null}}`, `{"commands":{"deny":{}}}`,
		`{"commands":{"deny":[null]}}`, `{"commands":{"deny":[{}]}}`, `{"commands":{"deny":[{"command":""}]}}`,
		`{"commands":{"deny":[{"command":"npm","extra":true}]}}`, `{"commands":{"deny":[{"command":"npm","args":null}]}}`,
		`{"commands":{"deny":[{"command":"npm","args":[null]}]}}`, `{"commands":{"deny":[{"command":"npm","args":[1]}]}}`,
		`{"git":{"allow":[]}}`, `{"git":{"deny":["unknown-action"]}}`, `{"git":{"deny":[1]}}`,
		`{"writePaths":{"allow":["/outside/**"]}}`, `{"writePaths":{"deny":["docs/../outside"]}}`,
		`{"writePaths":{"allow":[""]}}`, `{"writePaths":{"allow":[true]}}`, `{"writePaths":{"read":[]}}`,
		`{"tools":{"deny":["unknown-tool-kind"]}}`, `{"tools":{"allow":["mcp:server"]}}`, `{"tools":{"allow":["mcp:/tool"]}}`,
		`{"tools":{"deny":["mcp:server/"]}}`, `{"tools":{"allow":[null]}}`, `{"tools":{"other":[]}}`,
	} {
		t.Run(rules, func(t *testing.T) {
			if _, err := Read(withSets(1, aResolvedSet(rules)), configured); !errors.Is(err, ErrRefused) {
				t.Fatalf("Read(rules %s) = %v, want refusal", rules, err)
			}
		})
	}
}

func TestRulesRejectUnknownMessageFieldsRegardlessOfCase(t *testing.T) {
	payload := strings.Replace(anAssignment(1), `"sets":[]`, `"sets":[],"SETS":[]`, 1)
	if _, err := Read(payload, configured); !errors.Is(err, ErrRefused) {
		t.Fatalf("Read(SETS) = %v, want refusal", err)
	}
}
