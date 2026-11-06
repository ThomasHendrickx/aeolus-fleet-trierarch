package workspace

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// A ship's folder is its session's to write, `.git` and its config included, and with sessions in containers a session runs
// apart from the host (docs/trierarch.md, "Session runtime"). So the host's git calls in a ship's folder ignore the folder's own
// config where it names a program for git to run: git runs no hook, no fsmonitor, no filter, diff or merge driver, and no
// command for a transport, pager, editor or credential the folder's config names, and takes no optional lock. They go through
// inFolder, so no call can leave one of these in force. The machine's own config (global and system) applies as before.

// harmless are the values the host's git calls take in a ship's folder whatever its config says: no hooks and no fsmonitor.
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

// overridesIn are the overrides of every variable of the folder's own config that names a program, after the harmless ones.
func overridesIn(folder string) ([]override, error) {
	listed, err := exec.Command("git", "-C", folder, "config", "--list", "--show-scope", "--name-only", "-z").Output()
	if err != nil {
		return nil, fmt.Errorf("git config failed in %s: %w", folder, err)
	}
	overrides := append([]override{}, harmless...)
	fields := bytes.Split(bytes.TrimSuffix(listed, []byte{0}), []byte{0})
	for i := 0; i+1 < len(fields); i += 2 {
		scope, name := string(fields[i]), string(fields[i+1])
		if isTheFolders(scope) && isProgram(name) {
			overrides = append(overrides, neutralOf(name))
		}
	}
	return overrides, nil
}

// inFolder is git run in a ship's folder with the folder's own config naming no program, and only a local repository to fetch from.
func inFolder(folder string, args ...string) (*exec.Cmd, error) {
	overrides, err := overridesIn(folder)
	if err != nil {
		return nil, err
	}
	command := exec.Command("git", append([]string{"-C", folder}, args...)...)
	// Given in the environment rather than as -c, so a name holding an equals sign is taken whole.
	command.Env = append(os.Environ(), "GIT_CONFIG_COUNT="+strconv.Itoa(len(overrides)), "GIT_ALLOW_PROTOCOL=file", "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0")
	for i, each := range overrides {
		command.Env = append(command.Env, "GIT_CONFIG_KEY_"+strconv.Itoa(i)+"="+each.name, "GIT_CONFIG_VALUE_"+strconv.Itoa(i)+"="+each.value)
	}
	return command, nil
}
