// Package aipcommand is the aip CLI the trierarch keeps for its host sessions
// (#314): the version the session image ships, in a Python venv of its own
// under ~/.aeolus/trierarch, never the user's or the system's Python, with
// every package pip installs pinned by its hash. It needs a python3 of 3.14 or
// newer on the PATH; without one, sessions get no aip and the trierarch says
// why.
package aipcommand

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Version is the aip the host gets, the one the session image ships (its Containerfile's AIP_VERSION).
const Version = "0.7.0"

// requirements is aip at Version and every package it needs, each by version and hash.
//
//go:embed requirements.txt
var requirements []byte

// pythonNames are the names a python3 of 3.14 or newer is looked for by on the PATH, in order.
var pythonNames = []string{"python3", "python3.14", "python3.15", "python3.16"}

const (
	minimumMinor = 14
	runsOn       = "aip " + Version + " runs on Python 3.14 or newer"
	// installWait is how long a venv's make and pip's install each have.
	installWait = 10 * time.Minute
	// checkWait is how long a python or an aip has to state its version.
	checkWait = 30 * time.Second
	// saidMost is how much of what a failed command said its outcome keeps.
	saidMost = 2000
)

var pythonVersion = regexp.MustCompile(`^3\.(\d+)$`)

// State is how the host's aip stands: the version installed, or why there is none.
type State struct {
	Version string `json:"version,omitempty"`
	Missing string `json:"missing,omitempty"`
}

// Folder is the aip's venv and the outcome of its last install, which status and the report read.
type Folder struct {
	// Path is the venv, ~/.aeolus/trierarch/aip-command.
	Path string
	// Outcome is the last install's State, ~/.aeolus/trierarch/aip-command.json.
	Outcome string
	// SearchPath is the PATH a python3 is looked for on.
	SearchPath string
	// Log takes the line that says an install failed; none when nil.
	Log func(line string)
}

// installs lets one install at a time touch a folder: the run loop's checks and init's may meet.
var installs sync.Mutex

// State is the last install's outcome as kept; not installed yet when none is.
func (f Folder) State() State {
	text, err := os.ReadFile(f.Outcome)
	if err != nil {
		return State{Missing: "aip " + Version + " is not installed yet"}
	}
	var state State
	if err := json.Unmarshal(text, &state); err != nil || (state.Version == "") == (state.Missing == "") {
		return State{Missing: "aip " + Version + " is not installed yet"}
	}
	return state
}

// Bin is the folder's bin while it holds aip at Version, as its last install said and its files are there; false otherwise. It runs nothing, so a session's start may ask it.
func (f Folder) Bin() (string, bool) {
	if f.State().Version != Version {
		return "", false
	}
	bin := filepath.Join(f.Path, "bin")
	for _, name := range []string{"aip", "python"} {
		// Stat follows the venv's python to the Python it was made of, which may be gone.
		if info, err := os.Stat(filepath.Join(bin, name)); err != nil || info.IsDir() {
			return "", false
		}
	}
	return bin, true
}

// Ensure installs aip at Version into the folder unless it holds it already and its aip states it, and keeps the outcome. A failed install is logged and leaves no folder.
func (f Folder) Ensure() State {
	installs.Lock()
	defer installs.Unlock()
	if bin, ok := f.Bin(); ok && f.states(filepath.Join(bin, "aip")) {
		return f.State()
	}
	state := f.install()
	if state.Missing != "" && f.Log != nil {
		f.Log(state.Missing)
	}
	f.keep(state)
	return state
}

// states says whether the aip states Version.
func (f Folder) states(aip string) bool {
	said, err := f.output(checkWait, aip, "--version")
	return err == nil && (said == "aip "+Version || strings.HasPrefix(said, "aip "+Version+" "))
}

func (f Folder) install() State {
	python, why := f.python()
	if python == "" {
		return State{Missing: why}
	}
	if err := os.RemoveAll(f.Path); err != nil {
		return f.failed(err)
	}
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o700); err != nil {
		return f.failed(err)
	}
	if _, err := f.output(installWait, python, "-m", "venv", f.Path); err != nil {
		return f.failed(err)
	}
	locked := filepath.Join(f.Path, "requirements.txt")
	if err := os.WriteFile(locked, requirements, 0o644); err != nil {
		return f.failed(err)
	}
	// --isolated leaves out the user's pip configuration and PIP_ variables, so no other index or package comes in.
	if _, err := f.output(installWait, filepath.Join(f.Path, "bin", "python"), "-m", "pip", "install", "--isolated", "--require-hashes", "--no-deps", "--only-binary=:all:", "--no-input", "--disable-pip-version-check", "-r", locked); err != nil {
		return f.failed(err)
	}
	if !f.states(filepath.Join(f.Path, "bin", "aip")) {
		return f.failed(errors.New("its aip does not state " + Version))
	}
	return State{Version: Version}
}

func (f Folder) failed(err error) State {
	_ = os.RemoveAll(f.Path)
	return State{Missing: "the install of aip " + Version + " failed: " + err.Error()}
}

// python is the first python3 on the PATH of 3.14 or newer; none with why.
func (f Folder) python() (string, string) {
	firstVersion := ""
	for _, name := range pythonNames {
		found := f.lookPath(name)
		if found == "" {
			continue
		}
		said, err := f.output(checkWait, found, "-c", `import sys; print("%d.%d" % sys.version_info[:2])`)
		match := pythonVersion.FindStringSubmatch(said)
		if err != nil || match == nil {
			continue
		}
		if minor, _ := strconv.Atoi(match[1]); minor >= minimumMinor {
			return found, ""
		}
		if name == "python3" {
			firstVersion = said
		}
	}
	if firstVersion != "" {
		return "", "python3 on the PATH is " + firstVersion + ", and " + runsOn
	}
	return "", "no python3 on the PATH, and " + runsOn
}

func (f Folder) lookPath(name string) string {
	for _, folder := range filepath.SplitList(f.SearchPath) {
		if folder == "" {
			continue
		}
		path := filepath.Join(folder, name)
		if info, err := os.Stat(path); err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0 {
			return path
		}
	}
	return ""
}

// output runs the command on the search PATH: what it said on stdout, or an error with what it said.
func (f Folder) output(wait time.Duration, name string, words ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	command := exec.CommandContext(ctx, name, words...)
	command.Env = append(os.Environ(), "PATH="+f.SearchPath)
	var stderr strings.Builder
	command.Stderr = &stderr
	said, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("%s %s ended with %v: %s", filepath.Base(name), strings.Join(words[:min(len(words), 2)], " "), err, lastOf(stderr.String()+string(said)))
	}
	return strings.TrimSpace(string(said)), nil
}

func lastOf(said string) string {
	said = strings.TrimSpace(said)
	if len(said) > saidMost {
		return said[len(said)-saidMost:]
	}
	return said
}

// keep writes the outcome beside and renames it into place.
func (f Folder) keep(state State) {
	text, err := json.Marshal(state)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(f.Outcome), 0o700); err != nil {
		return
	}
	partial := f.Outcome + ".partial"
	if err := os.WriteFile(partial, append(text, '\n'), 0o644); err != nil {
		return
	}
	_ = os.Rename(partial, f.Outcome)
}
