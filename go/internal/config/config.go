// Package config is the trierarch's configuration, `~/.aeolus/trierarch/config.json`
// (docs/architecture.md, "Files on the machine"), in the shape common's schema
// gives it with what the trierarch adds. The Go trierarch has no common to
// import: it embeds the JSON Schema today's trierarch writes
// (config.schema.json, written again with `npm run go:schema`), and a test
// holds these types to it.
package config

import _ "embed"

// Schema is the configuration's JSON Schema, written beside it so an editor checks it.
//
//go:embed config.schema.json
var Schema []byte

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
