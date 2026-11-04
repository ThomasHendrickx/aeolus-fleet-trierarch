package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
)

// Listed is a ship as `list` says it, in the shape today's trierarch answers.
type Listed struct {
	ShipID    string `json:"shipId"`
	State     string `json:"state"`
	Harness   string `json:"harness"`
	Workspace string `json:"workspace"`
	Folder    string `json:"folder,omitempty"`
	Since     string `json:"since"`
	// Restarts is how often its session exited within the restart window.
	Restarts int `json:"restarts"`
}

// list is the ships the trierarch crews, from its saved state.
func list(at paths.Paths) (answer, error) {
	saved, err := state.File{Path: at.State}.Load()
	if err != nil {
		return answer{}, err
	}
	listed := []Listed{}
	for _, entry := range saved.Entries {
		workspace := "folder " + entry.Workspace.Name
		if entry.Workspace.Kind == "worktree" {
			workspace = "worktree " + entry.Workspace.Repository
			if entry.Workspace.Ref != "" {
				workspace += " at " + entry.Workspace.Ref
			}
		}
		listed = append(listed, Listed{ShipID: entry.ShipID, State: entry.State, Harness: entry.Harness, Workspace: workspace, Folder: entry.Folder, Since: entry.Since, Restarts: len(entry.Exits)})
	}
	slices.SortFunc(listed, func(a, b Listed) int { return strings.Compare(a.ShipID, b.ShipID) })
	if len(listed) == 0 {
		return answer{data: listed, text: "No ship is crewed here."}, nil
	}
	rows := [][]string{{"SHIP", "STATE", "HARNESS", "WORKSPACE", "SINCE", "RESTARTS"}}
	for _, each := range listed {
		rows = append(rows, []string{each.ShipID, each.State, each.Harness, each.Workspace, each.Since, fmt.Sprint(each.Restarts)})
	}
	widths := make([]int, len(rows[0]))
	for _, row := range rows {
		for column, cell := range row {
			widths[column] = max(widths[column], len(cell))
		}
	}
	lines := []string{}
	for _, row := range rows {
		cells := []string{}
		for column, cell := range row {
			if column < len(row)-1 {
				cell += strings.Repeat(" ", widths[column]-len(cell))
			}
			cells = append(cells, cell)
		}
		lines = append(lines, strings.Join(cells, "  "))
	}
	return answer{data: listed, text: strings.Join(lines, "\n")}, nil
}

// drive starts or restarts the service, and says once the new process said its version in running.json, 30 seconds at most.
func drive(at paths.Paths, machine Machine, done string, start func() error) (answer, error) {
	if err := start(); err != nil {
		return answer{}, err
	}
	said := []string{fmt.Sprintf("The trierarch %s; its sessions kept running.", done)}
	if !hasSaidItsVersion(machine.Service(at), at.Running, machine.Sleep) {
		said = append(said, notSaidYet)
	}
	return answer{data: map[string]any{"service": done, "said": said}, text: strings.Join(said, "\n")}, nil
}

var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

// nameMaxLength is common's TRIERARCH_NAME_MAX_LENGTH.
const nameMaxLength = 100

// add is `add repository|folder <name> <path>` (#381): it adds a place the trierarch may crew ships in, and trusts it, in one step; adding a place is what trusts it. Then the service restarts so the trierarch reads it; its sessions run on under their holds.
func add(at paths.Paths, machine Machine, words []string) (answer, error) {
	kind, name, written := words[0], words[1], words[2]
	if !namePattern.MatchString(name) || len(name) > nameMaxLength {
		return answer{}, fmt.Errorf("%s is no name: lowercase letters, digits and hyphens", name)
	}
	path := written
	if path == "~" || strings.HasPrefix(path, "~/") {
		path = machine.HomeDirectory + path[1:]
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return answer{}, err
	}
	if kind == "repository" {
		if _, err := os.Stat(filepath.Join(path, ".git")); err != nil {
			return answer{}, fmt.Errorf("%s is no git checkout", path)
		}
	} else if info, err := os.Stat(path); err != nil || !info.IsDir() {
		return answer{}, fmt.Errorf("%s is no folder", path)
	}
	configuration, err := config.Load(at.Config)
	if err != nil {
		return answer{}, err
	}
	held, isRepository := configuration.Repositories[name]
	heldFolder, isFolder := configuration.Folders[name]
	if isFolder {
		held = config.Repository{Path: heldFolder.Path}
	}
	if (isRepository || isFolder) && (held.Path != path || (kind == "repository") != isRepository) {
		return answer{}, fmt.Errorf("%s names %s already: pick another name", name, held.Path)
	}
	if kind == "repository" {
		repository := configuration.Repositories[name]
		repository.Path = path
		configuration.Repositories[name] = repository
	} else {
		configuration.Folders[name] = config.Folder{Path: path}
	}
	if err := config.Write(at.Config, configuration); err != nil {
		return answer{}, err
	}
	said := []string{fmt.Sprintf("Added the %s %s (%s) to %s.", kind, name, path, at.Config)}
	trustedBy := []string{}
	if _, ok := configuration.Harnesses[claudeCode]; ok {
		if err := machine.ClaudeCode(machine.HomeDirectory, variable(machine.Environ, "CLAUDE_CONFIG_DIR")).Trust(path); err != nil {
			return answer{}, err
		}
		trustedBy = append(trustedBy, claudeCode)
		said = append(said, "Claude Code trusts it.")
	}
	report := map[string]any{"kind": kind, "name": name, "path": path, "trustedBy": trustedBy}
	manager := machine.Service(at)
	status, err := manager.Status()
	if err != nil {
		return answer{}, err
	}
	if !status.IsInstalled {
		said = append(said, "The service is not installed: run aeolus-trierarch init to run it.")
		report["service"], report["said"] = "notInstalled", said
		return answer{data: report, text: strings.Join(said, "\n")}, nil
	}
	if err := manager.Restart(); err != nil {
		return answer{}, errors.Join(errors.New("added, but the service did not restart"), err)
	}
	said = append(said, "The trierarch restarted to offer it; its sessions kept running.")
	if !hasSaidItsVersion(manager, at.Running, machine.Sleep) {
		said = append(said, notSaidYet)
	}
	report["service"], report["said"] = "restarted", said
	return answer{data: report, text: strings.Join(said, "\n")}, nil
}
