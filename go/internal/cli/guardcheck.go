package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

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
	// The deadline holds for the whole command, so whatever it waits on, it answers and the process exits before the hook's timeout.
	ctx, cancel := context.WithTimeout(context.Background(), guard.Deadline)
	defer cancel()
	answered := make(chan guard.Answer, 1)
	go func() { answered <- guardAnswer(ctx, words, machine) }()
	var answer guard.Answer
	select {
	case answer = <-answered:
	case <-ctx.Done():
		answer = guard.Failed("deadline")
	}
	if answer.Stderr != "" && machine.Stderr != nil {
		fmt.Fprint(machine.Stderr, answer.Stderr)
	}
	return answer.Stdout, answer.ExitCode
}

func guardAnswer(ctx context.Context, words []string, machine Machine) guard.Answer {
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
	now := machine.Now
	if now == nil {
		now = time.Now
	}
	refusals := guardfile.Refusals{Guards: at.Guard, ShipID: shipID}
	// A call of a known ship, one whose guard folder is kept, refused before it could be checked is kept too.
	failed := func(cause string) guard.Answer {
		if _, err := os.Stat(guardfile.Folder(at.Guard, shipID)); err == nil {
			_ = refusals.Append(ctx, guard.FailedRefusal(now(), cause))
		}
		return guard.Failed(cause)
	}
	crewed, err := (state.File{Path: at.State}).Load()
	if err != nil {
		return failed("state unreadable")
	}
	entry, ok := crewed.Entries[shipID]
	if !ok || entry.Folder == "" {
		return failed("ship not crewed here")
	}
	shipFolder := entry.ShipFolder
	if shipFolder == "" {
		shipFolder = entry.Folder
	}
	repositories, err := workspace.RepositoryFolders(entry.Folder)
	if err != nil {
		return failed("ship's folder unreadable")
	}
	for index, repository := range repositories {
		repositories[index] = resolvedPath(repository)
	}
	if len(repositories) == 0 {
		repositories = []string{resolvedPath(entry.Folder)}
	}
	if machine.Stdin == nil {
		return failed("input unreadable")
	}
	checker := guard.Checker{
		Sets:      guardfile.Sets{Store: guardfile.Store{Guards: at.Guard}, ShipID: shipID},
		Links:     guardfile.Links{},
		Refusals:  refusals,
		Now:       now,
		Home:      machine.HomeDirectory,
		Boundary:  guard.Boundary{ShipFolder: resolvedPath(shipFolder), Repositories: repositories},
		Protected: guard.ClaudeCodeProtected(resolvedPath(machine.HomeDirectory), resolvedPath(guardfile.Folder(at.Guard, shipID)), resolvedPath(at.Config), append([]string{resolvedPath(shipFolder), resolvedPath(entry.Folder)}, repositories...)...),
	}
	return checker.Check(ctx, machine.Stdin)
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
