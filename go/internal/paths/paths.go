// Package paths is where the trierarch keeps its files (docs/architecture.md,
// "Files on the machine"): everything under `~/.aeolus/trierarch/`. Every
// ship's files are in its own folder under `ships/`, `ships/<shipId>/`, and no
// secret is in one: the trierarch's own files, its tokens for its ships among
// them, sit beside `ships/`. The configuration's path can be moved with
// `--config` or AEOLUS_TRIERARCH_CONFIG, and the place of `ships/` by the
// configuration's shipsRoot.
package paths

import (
	"path/filepath"
	"strings"
)

// In a ship's folder, `ships/<shipId>/`: its worktree or clone, its harness's home in a container, and the folder of its sockets, which
// a container mounts at the same path (a socket mounted alone would be the one the trierarch had open when the container started).
const (
	WorktreeFolder = "worktree"
	HomeFolder     = "home"
	SocketsFolder  = "sockets"
	// SocketFile is the ship's fleet socket in its sockets folder (decision 0026).
	SocketFile = "fleet.sock"
)

// ShipHome is the ship's own home, for a session in a container: in its ship's folder, or for a ship crewed before the ship folders
// (no ship's folder), under the homes as it was made.
func ShipHome(homes string, shipID string, shipFolder string) string {
	if shipFolder == "" {
		return filepath.Join(homes, shipID)
	}
	return filepath.Join(shipFolder, HomeFolder)
}

// ShipSockets is the folder of the ship's sockets: in its ship's folder, or for a ship crewed before the ship folders under the
// sockets folder as it was made.
func ShipSockets(sockets string, shipID string, shipFolder string) string {
	if shipFolder == "" {
		return filepath.Join(sockets, shipID)
	}
	return filepath.Join(shipFolder, SocketsFolder)
}

// longestShipID is as long as a ship id gets: `shp_` and its 26 characters.
var longestShipID = "shp_" + strings.Repeat("0", 26)

// LongestSocket is the longest socket path a ship's folder under the place of ships holds.
func LongestSocket(ships string) string {
	return filepath.Join(ships, longestShipID, SocketsFolder, SocketFile)
}

// SocketPathLimit is the size of a socket's path the system takes, its ending zero byte with it: 104 bytes on macOS, 108 on Linux.
func SocketPathLimit(system string) int {
	if system == "darwin" {
		return 104
	}
	return 108
}

type Paths struct {
	Home         string
	Config       string
	ConfigSchema string
	CrewToken    string
	Running      string
	Logs         string
	// Ships holds every ship's folder, `ships/<shipId>/`, unless the configuration's shipsRoot names another place.
	Ships string
	// Worktrees is the worktree root of the ships crewed before the ship folders, `<repository>/<ship>` under it.
	Worktrees string
	State     string
	// Sessions holds a folder per ship with its hold's files, its tokens among them: never in the ship's folder.
	Sessions string
	// Sockets holds a folder with its fleet socket per ship crewed before the ship folders.
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
	// Homes holds a home per ship crewed before the ship folders for sessions in containers, each mounted as its container's home (decision 0039).
	Homes string
	// TrustedRepositories is the list the trierarch plugin's ship sent last (aeolus-fleet#384), apart from the configuration.
	TrustedRepositories string
	// McpConfiguration is the fleet's MCP configuration the trierarch plugin's ship sent and the trierarch applied last, its secrets opened, mode 600: only the MCP proxy reads a value.
	McpConfiguration string
	// Superseded are the files and folders an older trierarch kept that none reads any more: the MCP server list and secrets the fleet's MCP configuration replaced, and the aip setting and CLI a fleet now adds as an MCP server of its own. A start removes them; they are the trierarch's own paths, so no installation of the user's is touched.
	Superseded []string
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
		Ships:        filepath.Join(home, "ships"),
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
		McpConfiguration:    filepath.Join(home, "mcp-configuration.json"),
		Superseded: []string{
			filepath.Join(home, "mcp-servers.json"),
			filepath.Join(home, "secrets.json"),
			filepath.Join(home, "aip.json"),
			filepath.Join(home, "aip-command"),
			filepath.Join(home, "aip-command.json"),
			filepath.Join(home, "aip-command.lock"),
		},
		SealingKey:   filepath.Join(home, "sealing-key"),
		Repositories: filepath.Join(home, "repositories"),
	}
}
