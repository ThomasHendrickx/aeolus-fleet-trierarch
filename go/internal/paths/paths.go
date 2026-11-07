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
	// Checkouts holds a folder per ship with its read-only checkouts, one per repository.
	Checkouts string
	// Keys holds each harness's API key, one file per harness (api keys K5); only login writes it, never the configuration.
	Keys string
	// Proxy holds the model proxy's files: its pid, its port and the key states (headless H16).
	Proxy string
	// Detected is what detection found per harness (#365), apart from the configuration.
	Detected string
	// ModelToken is the token sessions in containers run on (decision 0039).
	ModelToken string
	// Homes holds a home per ship for sessions in containers, each mounted as its container's home (decision 0039).
	Homes string
	// TrustedRepositories is the list the trierarch plugin's ship sent last (aeolus-fleet#384), apart from the configuration.
	TrustedRepositories string
	// McpServers is the MCP server list the trierarch plugin's ship sent last, apart from the configuration.
	McpServers string
	// Secrets is the secrets the trierarch plugin's ship sent last, opened, mode 600: only the MCP proxy reads them, and a session's start the aip read token.
	Secrets string
	// SealingKey is the trierarch's private key, mode 600, which opens the secrets sealed to the public key its report states.
	SealingKey string
	// Repositories holds the clones of the trusted repositories, one folder per repository.
	Repositories string
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
		Checkouts:    filepath.Join(home, "checkouts"),
		Keys:         filepath.Join(home, "keys"),
		Proxy:        filepath.Join(home, "proxy"),
		Detected:     filepath.Join(home, "detected.json"),
		ModelToken:   filepath.Join(home, "model-token"),
		Homes:        filepath.Join(home, "homes"),

		TrustedRepositories: filepath.Join(home, "trusted-repositories.json"),
		McpServers:          filepath.Join(home, "mcp-servers.json"),
		Secrets:             filepath.Join(home, "secrets.json"),
		SealingKey:          filepath.Join(home, "sealing-key"),
		Repositories:        filepath.Join(home, "repositories"),
	}
}
