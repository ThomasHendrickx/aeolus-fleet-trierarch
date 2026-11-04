// Package config is the trierarch's configuration, `~/.aeolus/trierarch/config.json`
// (docs/architecture.md, "Files on the machine"), in the shape common's schema
// gives it with what the trierarch adds. The Go trierarch has no common to
// import: it embeds the JSON Schema today's trierarch writes
// (config.schema.json, written again with `npm run go:schema`), and a test
// holds these types to it.
package config

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
)

// Schema is the configuration's JSON Schema, written beside it so an editor checks it.
//
//go:embed config.schema.json
var Schema []byte

// SchemaReference is what a configuration names as its schema: the file beside it.
const SchemaReference = "./config.schema.json"

type Configuration struct {
	Schema       string                `json:"$schema,omitempty"`
	WorktreeRoot string                `json:"worktreeRoot,omitempty"`
	Runtime      *Runtime              `json:"runtime,omitempty"`
	Caps         Caps                  `json:"caps"`
	Repositories map[string]Repository `json:"repositories"`
	Folders      map[string]Folder     `json:"folders"`
	Harnesses    map[string]Harness    `json:"harnesses"`
	Prices       map[string]Price      `json:"prices,omitempty"`
	Logins       *Logins               `json:"logins,omitempty"`
}

// Runtime is where the sessions run: on the host, or in a container of the runtime's binary with its caps.
type Runtime struct {
	Kind   string  `json:"kind"`
	Binary string  `json:"binary,omitempty"`
	Memory string  `json:"memory,omitempty"`
	Cpus   float64 `json:"cpus,omitempty"`
}

type Caps struct {
	Ships   int `json:"ships"`
	Running int `json:"running"`
}

type Repository struct {
	Path      string   `json:"path"`
	Checkouts []string `json:"checkouts,omitempty"`
}

type Folder struct {
	Path string `json:"path"`
}

type Harness struct {
	Flags   []string          `json:"flags"`
	Options map[string]Option `json:"options"`
}

// EffectiveFlags are the flags a launch gets: the harness's own, then each option's value as the settings picked it, or its default, by option name.
func (h Harness) EffectiveFlags(picked map[string]string) []string {
	flags := append([]string{}, h.Flags...)
	for _, name := range slices.Sorted(maps.Keys(h.Options)) {
		option := h.Options[name]
		value, ok := picked[name]
		if !ok {
			value = option.Default
		}
		flags = append(flags, option.Values[value]...)
	}
	return flags
}

type Option struct {
	Values  map[string][]string `json:"values"`
	Default string              `json:"default,omitempty"`
}

// Price is a model's price in US dollars per million tokens of each kind.
type Price struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

// Logins is which login each session runs on: a default per harness and a login per ship name.
type Logins struct {
	Default *DefaultLogins    `json:"default,omitempty"`
	Ships   map[string]string `json:"ships,omitempty"`
}

type DefaultLogins struct {
	ClaudeCode string `json:"claude-code,omitempty"`
	Codex      string `json:"codex,omitempty"`
}

// Initial is the configuration a fresh init writes: no repository or folder yet, Claude Code with no flag.
func Initial() Configuration {
	return Configuration{
		Schema:       SchemaReference,
		Caps:         Caps{Ships: 4, Running: 2},
		Repositories: map[string]Repository{},
		Folders:      map[string]Folder{},
		Harnesses:    map[string]Harness{"claude-code": {Flags: []string{}, Options: map[string]Option{}}},
	}
}

// requiredKeys are the keys the schema requires at the top.
var requiredKeys = []string{"caps", "repositories", "folders", "harnesses"}

// Load reads the configuration at the path, refusing one that is missing, no JSON, or of another shape.
func Load(path string) (Configuration, error) {
	text, err := os.ReadFile(path)
	if err != nil {
		return Configuration{}, fmt.Errorf("no configuration at %s: run aeolus-trierarch init first", path)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(text, &keys); err != nil {
		return Configuration{}, fmt.Errorf("the configuration at %s is no JSON object: %v", path, err)
	}
	for _, key := range requiredKeys {
		if _, ok := keys[key]; !ok {
			return Configuration{}, fmt.Errorf("the configuration at %s does not fit: it has no %s", path, key)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.DisallowUnknownFields()
	var configuration Configuration
	if err := decoder.Decode(&configuration); err != nil {
		return Configuration{}, fmt.Errorf("the configuration at %s does not fit: %v", path, err)
	}
	return configuration, nil
}

// Write writes the configuration to the path, as today's trierarch does: indented by two, with a last newline.
func Write(path string, configuration Configuration) error {
	text, err := json.MarshalIndent(configuration, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(text, '\n'), 0o644)
}

// WriteSchema writes the configuration's JSON Schema of this version to the path.
func WriteSchema(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, Schema, 0o644)
}

// Places are the paths of the configured repositories, then of the configured folders, each by name.
func (c Configuration) Places() (repositories []string, folders []string) {
	for _, name := range slices.Sorted(maps.Keys(c.Repositories)) {
		repositories = append(repositories, c.Repositories[name].Path)
	}
	for _, name := range slices.Sorted(maps.Keys(c.Folders)) {
		folders = append(folders, c.Folders[name].Path)
	}
	return repositories, folders
}
