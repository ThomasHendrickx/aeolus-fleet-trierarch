package guard

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Set is one resolved rule set of the rules message (design 4.4): its name,
// where it was read and its rules, the inner rules block of 4.1.
type Set struct {
	Name       string `json:"name"`
	Repository string `json:"repository"`
	Commit     string `json:"commit"`
	File       string `json:"file"`
	Floor      bool   `json:"floor"`
	Rules      Rules  `json:"rules"`
}

// Rules are the four rule types of a rule set, each optional.
type Rules struct {
	Commands   CommandRules `json:"commands"`
	Git        GitRules     `json:"git"`
	WritePaths PathRules    `json:"writePaths"`
	Tools      ToolRules    `json:"tools"`
}

// CommandRules deny commands, or allow only the listed ones when Allow is not empty.
type CommandRules struct {
	Deny  []CommandRule `json:"deny"`
	Allow []CommandRule `json:"allow"`
}

// CommandRule is a command name and, optionally, its first arguments, literal.
type CommandRule struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

// GitRules deny git actions from the closed list of 4.1.
type GitRules struct {
	Deny []string `json:"deny"`
}

// PathRules narrow where writes go, as globs relative to the ship's repositories.
type PathRules struct {
	Allow []string `json:"allow"`
	Deny  []string `json:"deny"`
}

// ToolRules deny tool kinds, or allow only the listed ones when Allow is not empty.
type ToolRules struct {
	Deny  []string `json:"deny"`
	Allow []string `json:"allow"`
}

// decodeSets reads the kept sets, refusing a field the rule set file does not have.
func decodeSets(raw []json.RawMessage) ([]Set, error) {
	sets := make([]Set, 0, len(raw))
	for index, entry := range raw {
		decoder := json.NewDecoder(bytes.NewReader(entry))
		decoder.DisallowUnknownFields()
		var set Set
		if err := decoder.Decode(&set); err != nil {
			return nil, fmt.Errorf("decode set %d: %w", index, err)
		}
		sets = append(sets, set)
	}
	return sets, nil
}
