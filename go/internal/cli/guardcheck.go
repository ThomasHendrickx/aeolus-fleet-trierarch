package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	codexharness "github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/codex"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/workspace"
)

// guardCheckCommand runs guard check (aeolus-fleet docs/design/guard, section 4.6): the PreToolUse hook of each guarded session
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
	if isCodexGuard(words) {
		return "", answer.ExitCode
	}
	return answer.Stdout, answer.ExitCode
}

// IsCodexGuardCheck is whether the guard hook answers Codex by exit status alone.
func IsCodexGuardCheck(args []string) bool {
	return IsGuardCheck(args) && isCodexGuard(args[2:])
}

func isCodexGuard(words []string) bool {
	command, _ := parse(words)
	return command.values["--harness"] == "codex"
}

func guardAnswer(ctx context.Context, words []string, machine Machine) guard.Answer {
	command, ok := parse(words)
	shipID := command.values["--ship"]
	harness := command.values["--harness"]
	switch harness {
	case "codex":
		shipID = variable(machine.Environ, "AEOLUS_SHIP")
	case "":
		harness = "claude-code"
	default:
		return guard.Failed("unknown harness")
	}
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
	workspaces := append([]string{resolvedPath(shipFolder), resolvedPath(entry.Folder)}, repositories...)
	guardFolder, configuration := resolvedPath(guardfile.Folder(at.Guard, shipID)), resolvedPath(at.Config)
	protected := guard.ClaudeCodeProtected(resolvedPath(machine.HomeDirectory), guardFolder, configuration, workspaces...)
	if harness == "codex" {
		home := codexharness.HomeOf(machine.HomeDirectory, variable(machine.Environ, "CODEX_HOME"))
		protected = guard.CodexProtected(resolvedPath(home), guardFolder, configuration, workspaces...)
		protected = append(protected, resolvedPath(at.Detected), resolvedPath(at.State))
	}
	checker := guard.Checker{
		Harness:   harness,
		Sets:      guardfile.Sets{Store: guardfile.Store{Guards: at.Guard}, ShipID: shipID},
		Links:     guardfile.Links{},
		Refusals:  refusals,
		Now:       now,
		Home:      machine.HomeDirectory,
		Boundary:  guard.Boundary{ShipFolder: resolvedPath(shipFolder), Repositories: repositories},
		Protected: protected,
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

func prepareCodexTurn(program, folder string, environment, command []string) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), guard.Deadline)
	defer cancel()
	home := variable(environment, "HOME")
	config := variable(environment, "AEOLUS_TRIERARCH_CONFIG")
	turn := codexharness.GuardTurn{
		Program: program, Folder: folder, Environment: environment, Version: Version,
		Paths: paths.Of(home, config), ShipID: variable(environment, "AEOLUS_SHIP"),
	}
	return turn.Prepare(ctx, command)
}
