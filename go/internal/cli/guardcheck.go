package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	codexharness "github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/codex"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/container"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
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
	view := hostView{home: machine.HomeDirectory, harness: harness, codexHome: variable(machine.Environ, "CODEX_HOME")}
	return checkCall(ctx, at, shipID, now, view, machine.Stdin)
}

// ContainerGuardCheck is guard check over the ship's socket for a session in a container (#631): the call checked on the host
// against the rules kept for it, on its container's view of its files, through the mounts the runtime gives its container.
func ContainerGuardCheck(at paths.Paths, runtime container.Runtime) func(ctx context.Context, shipID string, input io.ReadCloser) guard.Answer {
	return func(ctx context.Context, shipID string, input io.ReadCloser) guard.Answer {
		if !crew.IsShipID(shipID) {
			return guard.Failed("no ship")
		}
		return checkCall(ctx, at, shipID, time.Now, containerView{runtime: runtime}, input)
	}
}

// failedCheck refuses a call that could not be checked, kept as a refusal of a known ship, one whose guard folder is kept.
func failedCheck(ctx context.Context, at paths.Paths, shipID string, now func() time.Time, cause string) guard.Answer {
	if _, err := os.Stat(guardfile.Folder(at.Guard, shipID)); err == nil {
		_ = (guardfile.Refusals{Guards: at.Guard, ShipID: shipID}).Append(ctx, guard.FailedRefusal(now(), cause))
	}
	return guard.Failed(cause)
}

// sessionView is the file system a guarded session's calls name: the host's, or its container's.
type sessionView interface {
	// checked are the session's home, the paths the guard compares the call's writes to as the session sees them, and its links.
	checked(at paths.Paths, entry reconciler.Entry, workspaces []string) (home string, protected []string, links guard.Links, harness string)
	// path is a folder of the host as the session sees it.
	path(folder string) string
}

// hostView is a session on the host: its paths with their links resolved, as the guard names the paths it refuses.
type hostView struct {
	home, harness, codexHome string
}

func (v hostView) path(folder string) string { return resolvedPath(folder) }

func (v hostView) checked(at paths.Paths, entry reconciler.Entry, workspaces []string) (string, []string, guard.Links, string) {
	guardFolder, configuration := resolvedPath(guardfile.Folder(at.Guard, entry.ShipID)), resolvedPath(at.Config)
	if v.harness == "codex" {
		home := codexharness.HomeOf(v.home, v.codexHome)
		protected := guard.CodexProtected(resolvedPath(home), guardFolder, configuration, workspaces...)
		return v.home, append(protected, resolvedPath(at.Detected), resolvedPath(at.State)), guardfile.Links{}, v.harness
	}
	return v.home, guard.ClaudeCodeProtected(resolvedPath(v.home), guardFolder, configuration, workspaces...), guardfile.Links{}, v.harness
}

// containerView is a Claude Code session in a container: its workspace at its own path, its home the container's, and its links read
// through the folders its container mounts. The guard's folder and the configuration are no folder it sees, protected all the same.
type containerView struct {
	runtime container.Runtime
}

func (v containerView) path(folder string) string { return folder }

func (v containerView) checked(at paths.Paths, entry reconciler.Entry, workspaces []string) (string, []string, guard.Links, string) {
	var mounts []guardfile.Mount
	for _, mount := range v.runtime.Mounts(entry.ShipID, entry.Folder, entry.ShipFolder) {
		mounts = append(mounts, guardfile.Mount{Host: mount.Host, Container: mount.Container})
	}
	protected := guard.ClaudeCodeProtected(container.SessionHome, guardfile.Folder(at.Guard, entry.ShipID), at.Config, workspaces...)
	return container.SessionHome, protected, guardfile.ContainerLinks{Mounts: mounts}, "claude-code"
}

// checkCall checks the ship's call as its session sees its files.
func checkCall(ctx context.Context, at paths.Paths, shipID string, now func() time.Time, view sessionView, input io.ReadCloser) guard.Answer {
	refusals := guardfile.Refusals{Guards: at.Guard, ShipID: shipID}
	failed := func(cause string) guard.Answer { return failedCheck(ctx, at, shipID, now, cause) }
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
		repositories[index] = view.path(repository)
	}
	if len(repositories) == 0 {
		repositories = []string{view.path(entry.Folder)}
	}
	if input == nil {
		return failed("input unreadable")
	}
	entry.ShipID = shipID
	workspaces := append([]string{view.path(shipFolder), view.path(entry.Folder)}, repositories...)
	home, protected, links, harness := view.checked(at, entry, workspaces)
	checker := guard.Checker{
		Harness:   harness,
		Sets:      guardfile.Sets{Store: guardfile.Store{Guards: at.Guard}, ShipID: shipID},
		Links:     links,
		Refusals:  refusals,
		Now:       now,
		Home:      home,
		Boundary:  guard.Boundary{ShipFolder: view.path(shipFolder), Repositories: repositories},
		Protected: protected,
	}
	return checker.Check(ctx, input)
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
