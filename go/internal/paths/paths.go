// Package paths is where the trierarch keeps its files (docs/architecture.md,
// "Files on the machine"): everything under `~/.aeolus/trierarch/`. The
// configuration's path can be moved with `--config` or
// AEOLUS_TRIERARCH_CONFIG, and the worktree root by the configuration.
package paths

import "path/filepath"

type Paths struct {
	Home         string
	Config       string
	ConfigSchema string
	CrewToken    string
	Running      string
	Logs         string
	Worktrees    string
	State        string
	// Sessions holds a folder per ship with its hold's files.
	Sessions string
	// Sockets holds a folder per ship with its fleet socket.
	Sockets string
}

// Of the user's home folder, with the configuration at config when it is not empty.
func Of(homeDirectory string, config string) Paths {
	home := filepath.Join(homeDirectory, ".aeolus", "trierarch")
	if config == "" {
		config = filepath.Join(home, "config.json")
	}
	return Paths{
		Home:         home,
		Config:       config,
		ConfigSchema: filepath.Join(home, "config.schema.json"),
		CrewToken:    filepath.Join(home, "crew-token"),
		Running:      filepath.Join(home, "running.json"),
		Logs:         filepath.Join(home, "logs"),
		Worktrees:    filepath.Join(home, "worktrees"),
		State:        filepath.Join(home, "state.json"),
		Sessions:     filepath.Join(home, "sessions"),
		Sockets:      filepath.Join(home, "sockets"),
	}
}
