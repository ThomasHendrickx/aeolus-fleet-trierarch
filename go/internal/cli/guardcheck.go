package cli

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/workspace"
)

// guardCheckCommand runs guard check (aeolus-fleet docs/design/guard, section 4.6): the PreToolUse hook of every Claude Code session
// the trierarch starts. It prints the hook's answer, writes the refusal to stderr and exits with its code; whatever goes wrong before
// the check can run refuses the call too, so it fails closed.
func guardCheckCommand(words []string, machine Machine) (string, int) {
	answer := guardAnswer(words, machine)
	if answer.Stderr != "" && machine.Stderr != nil {
		fmt.Fprint(machine.Stderr, answer.Stderr)
	}
	return answer.Stdout, answer.ExitCode
}

func guardAnswer(words []string, machine Machine) guard.Answer {
	command, ok := parse(words)
	shipID := command.values["--ship"]
	if !ok || len(command.words) != 0 || !crew.IsShipID(shipID) {
		return guard.Failed("no ship")
	}
	configPath := command.values["--config"]
	if configPath == "" {
		configPath = variable(machine.Environ, "AEOLUS_TRIERARCH_CONFIG")
	}
	at := paths.Of(machine.HomeDirectory, configPath)
	crewed, err := (state.File{Path: at.State}).Load()
	if err != nil {
		return guard.Failed("state unreadable")
	}
	entry, ok := crewed.Entries[shipID]
	if !ok || entry.Folder == "" {
		return guard.Failed("ship not crewed here")
	}
	shipFolder := entry.ShipFolder
	if shipFolder == "" {
		shipFolder = entry.Folder
	}
	repositories, err := workspace.RepositoryFolders(entry.Folder)
	if err != nil {
		return guard.Failed("ship's folder unreadable")
	}
	for index, repository := range repositories {
		repositories[index] = resolvedPath(repository)
	}
	if len(repositories) == 0 {
		repositories = []string{resolvedPath(entry.Folder)}
	}
	if machine.Stdin == nil {
		return guard.Failed("input unreadable")
	}
	checker := guard.Checker{
		Sets:      guardfile.Sets{Store: guardfile.Store{Ships: at.Ships}, ShipID: shipID},
		Links:     guardfile.Links{},
		Refusals:  guardfile.Refusals{Ships: at.Ships, ShipID: shipID},
		Now:       machine.Now,
		Home:      machine.HomeDirectory,
		Boundary:  guard.Boundary{ShipFolder: resolvedPath(shipFolder), Repositories: repositories},
		Protected: guard.ClaudeCodeProtected(resolvedPath(machine.HomeDirectory), resolvedPath(shipFolder), resolvedPath(guardfile.Folder(at.Ships, shipID)), resolvedPath(at.Config)),
	}
	return checker.Check(context.Background(), machine.Stdin)
}

// resolvedPath is the path with the links of its longest part that exists resolved, as the guard compares the paths a call writes.
func resolvedPath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved
	}
	parent := filepath.Dir(path)
	if parent == path {
		return path
	}
	return filepath.Join(resolvedPath(parent), filepath.Base(path))
}
