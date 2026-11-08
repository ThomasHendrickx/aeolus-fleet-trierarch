// Package aipcommand is the aip CLI the trierarch keeps for its host sessions
// (#314): the version the session image ships, installed as the image does,
// by uv, all in a folder of its own under ~/.aeolus/trierarch, never the
// user's or the system's Python. uv is downloaded at a pinned version and
// checked by its published sha256; it installs a pinned CPython and a venv of
// it, and into that venv aip and every package it needs, each pinned by its
// hash. It needs no Python on the host; once installed, no network.
package aipcommand

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// Version is the aip the host gets, the one the session image ships (its Containerfile's AIP_VERSION).
	Version = "0.7.0"
	// UvVersion is the uv that installs it, the one the image takes.
	UvVersion = "0.13.7"
	// PythonVersion is the CPython aip runs on, of the image's minor (its PYTHON_VERSION), as uv UvVersion offers it.
	PythonVersion = "3.14.10"
)

// requirements is aip at Version and every package it needs, each by version and hash.
//
//go:embed requirements.txt
var requirements []byte

// Uv is a build of uv: its archive and the sha256 its release publishes for it.
type Uv struct {
	URL    string
	SHA256 string
}

const uvReleases = "https://github.com/astral-sh/uv/releases/download/" + UvVersion + "/uv-"

// uvBuilds are uv UvVersion's builds by Go's platform and chip, each with the sha256 of its release's .sha256 file. Linux takes the static musl build, which runs on any libc.
var uvBuilds = map[string]Uv{
	"linux/amd64":  {URL: uvReleases + "x86_64-unknown-linux-musl.tar.gz", SHA256: "287491da03f2a785c70fa75b13e1f849918c2f2b5415fe84876b8214eeb792f9"},
	"linux/arm64":  {URL: uvReleases + "aarch64-unknown-linux-musl.tar.gz", SHA256: "2d3ec076a0c4c0e8250bb6418c44080828b544f1a3be0b6e46adf9fb6923de45"},
	"darwin/amd64": {URL: uvReleases + "x86_64-apple-darwin.tar.gz", SHA256: "20c47e4c1f630b8abaff8c291fa9b9aa300fef92c4fbff95adf198b55287cda7"},
	"darwin/arm64": {URL: uvReleases + "aarch64-apple-darwin.tar.gz", SHA256: "81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731"},
}

// UvFor is uv's build for the platform and chip, by Go's names; false when uv has none.
func UvFor(goos string, goarch string) (Uv, bool) {
	build, ok := uvBuilds[goos+"/"+goarch]
	return build, ok
}

const (
	// downloadWait is how long uv's download has.
	downloadWait = 5 * time.Minute
	// uvMost is the most of uv's archive read: its builds are some 20 MB.
	uvMost = 200 << 20
	// installWait is how long each of uv's steps has.
	installWait = 10 * time.Minute
	// checkWait is how long an aip has to state its version.
	checkWait = 30 * time.Second
	// saidMost is how much of what a failed command said its outcome keeps.
	saidMost = 2000
)

// State is how the host's aip stands: the version installed, or why there is none.
type State struct {
	Version string `json:"version,omitempty"`
	Missing string `json:"missing,omitempty"`
}

// Folder is the aip's folder and the outcome of its last install, which status and the report read. In the folder: uv, the Python it installed (python), the venv aip is in (venv) and the lock (requirements.txt).
type Folder struct {
	// Path is the folder, ~/.aeolus/trierarch/aip-command.
	Path string
	// Outcome is the last install's State, ~/.aeolus/trierarch/aip-command.json.
	Outcome string
	// Uv is uv's build for this machine; none when uv has none.
	Uv *Uv
	// Log takes the line that says an install failed; none when nil.
	Log func(line string)
}

// installs lets one install at a time touch a folder: the run loop's checks and init's may meet.
var installs sync.Mutex

var notYet = State{Missing: "aip " + Version + " is not installed yet"}

// State is the last install's outcome as kept; not installed yet when none is.
func (f Folder) State() State {
	text, err := os.ReadFile(f.Outcome)
	if err != nil {
		return notYet
	}
	var state State
	if err := json.Unmarshal(text, &state); err != nil || (state.Version == "") == (state.Missing == "") {
		return notYet
	}
	return state
}

func (f Folder) venvBin() string { return filepath.Join(f.Path, "venv", "bin") }

// Bin is the venv's bin while it holds aip at Version, as its last install said and its files are there; false otherwise. It runs nothing, so a session's start may ask it.
func (f Folder) Bin() (string, bool) {
	if f.State().Version != Version {
		return "", false
	}
	bin := f.venvBin()
	for _, name := range []string{"aip", "python"} {
		// Stat follows the venv's python to the Python uv installed, which may be gone.
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
	said, err := run(checkWait, nil, aip, "--version")
	return err == nil && (said == "aip "+Version || strings.HasPrefix(said, "aip "+Version+" "))
}

func (f Folder) install() State {
	if f.Uv == nil {
		return State{Missing: "uv " + UvVersion + ", which installs aip " + Version + ", has no build for this machine"}
	}
	if err := f.installIn(); err != nil {
		_ = os.RemoveAll(f.Path)
		return State{Missing: "the install of aip " + Version + " failed: " + err.Error()}
	}
	return State{Version: Version}
}

func (f Folder) installIn() error {
	if err := os.RemoveAll(f.Path); err != nil {
		return err
	}
	if err := os.MkdirAll(f.Path, 0o700); err != nil {
		return err
	}
	uv := filepath.Join(f.Path, "uv")
	if err := f.downloadUv(uv); err != nil {
		return err
	}
	env := f.uvEnvironment()
	venv := filepath.Join(f.Path, "venv")
	if _, err := run(installWait, env, uv, "python", "install", PythonVersion, "--no-bin"); err != nil {
		return err
	}
	if _, err := run(installWait, env, uv, "venv", "--python", PythonVersion, venv); err != nil {
		return err
	}
	locked := filepath.Join(f.Path, "requirements.txt")
	if err := os.WriteFile(locked, requirements, 0o644); err != nil {
		return err
	}
	if _, err := run(installWait, env, uv, "pip", "install", "--python", filepath.Join(venv, "bin", "python"), "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", locked); err != nil {
		return err
	}
	if err := os.RemoveAll(filepath.Join(f.Path, "cache")); err != nil {
		return err
	}
	if !f.states(filepath.Join(venv, "bin", "aip")) {
		return errors.New("its aip does not state " + Version)
	}
	return nil
}

// uvEnvironment is the trierarch's environment without the user's uv, pip and Python variables, so no other index, Python or configuration comes in, and with uv's Python and cache in the folder.
func (f Folder) uvEnvironment() []string {
	env := []string{}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "UV_") || strings.HasPrefix(name, "PIP_") || strings.HasPrefix(name, "PYTHON") || name == "VIRTUAL_ENV" {
			continue
		}
		env = append(env, entry)
	}
	return append(env,
		"UV_NO_CONFIG=1",
		"UV_PYTHON_PREFERENCE=only-managed",
		"UV_PYTHON_INSTALL_DIR="+filepath.Join(f.Path, "python"),
		"UV_CACHE_DIR="+filepath.Join(f.Path, "cache"),
	)
}

// downloadUv writes uv from its build's archive once the archive matches its sha256; one that does not is never opened.
func (f Folder) downloadUv(to string) error {
	ctx, cancel := context.WithTimeout(context.Background(), downloadWait)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, f.Uv.URL, nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("uv %s could not be downloaded: %w", UvVersion, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("uv %s could not be downloaded: %s answered %s", UvVersion, f.Uv.URL, response.Status)
	}
	archive, err := io.ReadAll(io.LimitReader(response.Body, uvMost))
	if err != nil {
		return fmt.Errorf("uv %s could not be downloaded: %w", UvVersion, err)
	}
	if sum := sha256.Sum256(archive); hex.EncodeToString(sum[:]) != f.Uv.SHA256 {
		return fmt.Errorf("uv %s's download does not match its sha256", UvVersion)
	}
	return extractUv(archive, to)
}

// extractUv writes the archive's uv program, the file named uv in its one folder.
func extractUv(archive []byte, to string) error {
	unzipped, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return err
	}
	files := tar.NewReader(unzipped)
	for {
		header, err := files.Next()
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("uv %s's archive holds no uv", UvVersion)
		}
		if err != nil {
			return err
		}
		if header.Typeflag != tar.TypeReg || path.Base(header.Name) != "uv" {
			continue
		}
		program, err := os.OpenFile(to, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(program, io.LimitReader(files, uvMost)); err != nil {
			_ = program.Close()
			return err
		}
		return program.Close()
	}
}

// run runs the command, with env when it is given: what it said on stdout, or an error with what it said.
func run(wait time.Duration, env []string, name string, words ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	command := exec.CommandContext(ctx, name, words...)
	command.Env = env
	var stderr strings.Builder
	command.Stderr = &stderr
	said, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("%s %s ended with %v: %s", filepath.Base(name), strings.Join(words[:min(len(words), 2)], " "), err, lastOf(stderr.String()+string(said)))
	}
	return strings.TrimSpace(string(said)), nil
}

// lastOf is the end of what a command said, on one line, as status says it.
func lastOf(said string) string {
	said = strings.Join(strings.Fields(said), " ")
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
