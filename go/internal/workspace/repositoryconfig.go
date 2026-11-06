package workspace

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// A ship's folder is its session's to write, `.git` and its config included, and with sessions in containers a session runs
// apart from the host (docs/trierarch.md, "Session runtime"). So the host's git calls in a ship's folder ignore the folder's own
// config where it names a program for git to run: git runs no hook, in a folder or in the config, no fsmonitor, no filter, diff or merge driver, and no
// command for a transport, pager, editor or credential the folder's config names, and takes no optional lock. They go through
// inFolder, so no call can leave one of these in force. The machine's own config (global and system) applies as before. Git is
// pointed at no folder but the ship's own: a folder whose config sets core.worktree is not read, and a clone is read only
// through its own `.git` folder, with its own objects alone (inClone). A folder that is not read is refused with why (RefusedError), so what it holds is not
// known.

// RefusedError is a folder the host does not read, with why.
type RefusedError struct {
	Folder string
	Reason string
}

func (e *RefusedError) Error() string {
	return fmt.Sprintf("will not read %s: %s", e.Folder, e.Reason)
}

// harmless are the values the host's git calls take in a ship's folder whatever its config says: no hooks in a folder and no fsmonitor.
var harmless = []override{{"core.fsmonitor", "false"}, {"core.hooksPath", "/dev/null"}}

// namesAProgram are the config variables that name a program git runs, by section, then by variable; a section of three-part
// names (`filter.<driver>.clean`) holds the variables of any subsection.
var namesAProgram = map[string]map[string]bool{
	"core":        {"sshcommand": true, "pager": true, "editor": true, "askpass": true, "gitproxy": true, "alternaterefscommand": true},
	"sequence":    {"editor": true},
	"diff":        {"external": true, "command": true, "textconv": true},
	"filter":      {"clean": true, "smudge": true, "process": true, "required": true},
	"merge":       {"driver": true},
	"gpg":         {"program": true},
	"credential":  {"helper": true},
	"interactive": {"difffilter": true},
	"remote":      {"uploadpack": true, "receivepack": true},
	"mergetool":   {"cmd": true},
	"difftool":    {"cmd": true},
}

type override struct {
	name  string
	value string
}

// isTheFolders says whether a config scope is the folder's own: its `.git/config`, what it includes, and its worktree's config.
func isTheFolders(scope string) bool {
	return scope == "local" || scope == "worktree"
}

// neutralOf is the value that turns the variable off: a filter that is not required, no pager, else no program.
func neutralOf(name string) override {
	section, _, _ := strings.Cut(name, ".")
	if section == "pager" || (section == "filter" && strings.HasSuffix(name, ".required")) {
		return override{name, "false"}
	}
	return override{name, ""}
}

// hookOffOf is the hook a variable of a hook in the config (`hook.<name>.command`) belongs to, turned off and bound to no event; none
// for another variable.
func hookOffOf(name string) []override {
	first := strings.Index(name, ".")
	last := strings.LastIndex(name, ".")
	if first < 0 || name[:first] != "hook" || last == first {
		return nil
	}
	hook := name[:last]
	// An empty event resets the hook's events.
	return []override{{hook + ".enabled", "false"}, {hook + ".event", ""}, {hook + ".command", ""}}
}

// isProgram says whether the variable, as git lists it (section and variable in lower case), names a program git runs.
func isProgram(name string) bool {
	first := strings.Index(name, ".")
	last := strings.LastIndex(name, ".")
	if first < 0 {
		return false
	}
	section, variable := name[:first], name[last+1:]
	return section == "pager" || namesAProgram[section][variable]
}

// overridesIn are the overrides of every variable of the folder's own config that names a program, after the harmless ones; a
// folder whose config points git at another work tree is not read.
func overridesIn(folder string, located []string) ([]override, error) {
	listing := exec.Command("git", "-C", folder, "config", "--list", "--show-scope", "--name-only", "-z")
	listing.Env = append(os.Environ(), located...)
	listed, err := listing.Output()
	if err != nil {
		return nil, fmt.Errorf("git config failed in %s: %w", folder, err)
	}
	overrides := append([]override{}, harmless...)
	fields := bytes.Split(bytes.TrimSuffix(listed, []byte{0}), []byte{0})
	for i := 0; i+1 < len(fields); i += 2 {
		scope, name := string(fields[i]), string(fields[i+1])
		if !isTheFolders(scope) {
			continue
		}
		if name == "core.worktree" {
			return nil, &RefusedError{folder, "its config sets core.worktree, which points git at another folder"}
		}
		if isProgram(name) {
			overrides = append(overrides, neutralOf(name))
		}
		for _, off := range hookOffOf(name) {
			if !slices.Contains(overrides, off) {
				overrides = append(overrides, off)
			}
		}
	}
	return overrides, nil
}

// inFolder is git run in a ship's folder with the folder's own config naming no program, and only a local repository to fetch from.
func inFolder(folder string, args ...string) (*exec.Cmd, error) {
	return located(folder, nil, args)
}

// inClone is git run in a ship's clone as in its folder, through the clone's own `.git` folder and with the clone as its work tree,
// whatever the clone says: a `.git` that is a file or a link, that names another folder's in its commondir, that holds a link, or
// that names another repository's objects in its alternates, would point git at another folder, so such a clone is not read.
func inClone(clone string, args ...string) (*exec.Cmd, error) {
	gitFolder := filepath.Join(clone, ".git")
	if found, err := os.Lstat(gitFolder); err != nil || !found.IsDir() {
		return nil, &RefusedError{clone, "its .git is no folder of its own"}
	}
	if _, err := os.Lstat(filepath.Join(gitFolder, "commondir")); err == nil {
		return nil, &RefusedError{clone, "its .git names another git folder in its commondir"}
	}
	link, err := linkIn(gitFolder)
	if err != nil {
		return nil, err
	}
	if link != "" {
		return nil, &RefusedError{clone, "its .git holds a link: " + link}
	}
	if _, err := os.Lstat(filepath.Join(gitFolder, "objects", "info", "alternates")); err == nil {
		return nil, &RefusedError{clone, "its .git names another repository's objects in objects/info/alternates"}
	}
	return located(clone, []string{"GIT_DIR=" + gitFolder, "GIT_WORK_TREE=" + clone}, args)
}

// linkIn is the first link in the git folder, by its path in it, or none: none is read through, as it would lead git out of it.
func linkIn(gitFolder string) (string, error) {
	link := ""
	// WalkDir follows no link: one to a folder is a link it does not enter.
	err := filepath.WalkDir(gitFolder, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			link, err = filepath.Rel(gitFolder, path)
			if err != nil {
				return err
			}
			return fs.SkipAll
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("list %s: %w", gitFolder, err)
	}
	return link, nil
}

// located is git run in the folder, with where it finds its repository given in the environment when it is.
func located(folder string, at []string, args []string) (*exec.Cmd, error) {
	overrides, err := overridesIn(folder, at)
	if err != nil {
		return nil, err
	}
	command := exec.Command("git", append([]string{"-C", folder}, args...)...)
	// Given in the environment rather than as -c, so a name holding an equals sign is taken whole.
	command.Env = append(append(os.Environ(), at...), "GIT_CONFIG_COUNT="+strconv.Itoa(len(overrides)), "GIT_ALLOW_PROTOCOL=file", "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0")
	for i, each := range overrides {
		command.Env = append(command.Env, "GIT_CONFIG_KEY_"+strconv.Itoa(i)+"="+each.name, "GIT_CONFIG_VALUE_"+strconv.Itoa(i)+"="+each.value)
	}
	return command, nil
}
