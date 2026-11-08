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
	"syscall"
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

// Folder is the aip's folder and the outcome of its last install, which status and the report read. In the folder: uv, the Python it installed (python), the venv aip is in (venv), the links to aip and aip-spec alone that a session takes onto its PATH (bin, #319), the lock (requirements.txt), and aip's skills as a plugin a harness is started with (plugin, #315), with the home aip keeps its record of them in (aip-home), never the user's.
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

// failedPrefix opens why there is no aip when an install failed.
const failedPrefix = "the install of aip " + Version + " failed: "

// Brief is why there is no aip, as short as a report's note takes it: a failed install's own words are left to status. Empty while aip is there.
func (s State) Brief() string {
	if strings.HasPrefix(s.Missing, failedPrefix) {
		return "its install failed, as aeolus-trierarch status says"
	}
	return s.Missing
}

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

// PathWithout is the PATH without any entry in or under the folder, the others in their order: what a session or the service was handed through an upgrade run from a host session that had aip's folders on its PATH (#321).
func PathWithout(path string, folder string) string {
	if folder == "" {
		return path
	}
	kept := []string{}
	for _, entry := range filepath.SplitList(path) {
		if entry != folder && !strings.HasPrefix(entry, folder+string(filepath.Separator)) {
			kept = append(kept, entry)
		}
	}
	return strings.Join(kept, string(os.PathListSeparator))
}

func (f Folder) venvBin() string { return filepath.Join(f.Path, "venv", "bin") }

// bin is the folder of links to aip's commands alone, the one a session takes onto its PATH: the venv's own bin holds its python, python3 and activate scripts and its dependencies' commands too.
func (f Folder) bin() string { return filepath.Join(f.Path, "bin") }

// commands are the venv's commands a session gets, and no other.
var commands = []string{"aip", "aip-spec"}

func (f Folder) plugin() string { return filepath.Join(f.Path, "plugin") }

// skills are the skills `aip skill install` writes, each a folder with its SKILL.md.
var skills = []string{"aip-compile", "aip-runtime"}

// Bin is the folder of links to aip and aip-spec alone while the venv holds aip at Version and its skills, as its last install said and its files are there; false otherwise. A folder from before it, or one holding anything else, is broken. It runs nothing, so a session's start may ask it.
func (f Folder) Bin() (string, bool) {
	if f.State().Version != Version {
		return "", false
	}
	for _, name := range []string{"aip", "python"} {
		// Stat follows the venv's python to the Python uv installed, which may be gone.
		if info, err := os.Stat(filepath.Join(f.venvBin(), name)); err != nil || info.IsDir() {
			return "", false
		}
	}
	if !f.holdsCommandsAlone() {
		return "", false
	}
	for _, name := range append([]string{filepath.Join(".claude-plugin", "plugin.json")}, skillFiles()...) {
		if info, err := os.Stat(filepath.Join(f.plugin(), name)); err != nil || info.IsDir() {
			return "", false
		}
	}
	return f.bin(), true
}

// holdsCommandsAlone says whether bin holds a link that leads to each command of the venv, and nothing else.
func (f Folder) holdsCommandsAlone() bool {
	entries, err := os.ReadDir(f.bin())
	if err != nil || len(entries) != len(commands) {
		return false
	}
	for _, name := range commands {
		if info, err := os.Stat(filepath.Join(f.bin(), name)); err != nil || info.IsDir() {
			return false
		}
		if target, err := os.Readlink(filepath.Join(f.bin(), name)); err != nil || target != filepath.Join("..", "venv", "bin", name) {
			return false
		}
	}
	return true
}

// linkCommands makes bin with a link to each of the venv's commands.
func (f Folder) linkCommands() error {
	if err := os.MkdirAll(f.bin(), 0o700); err != nil {
		return err
	}
	for _, name := range commands {
		if err := os.Symlink(filepath.Join("..", "venv", "bin", name), filepath.Join(f.bin(), name)); err != nil {
			return err
		}
	}
	return nil
}

func skillFiles() []string {
	files := []string{}
	for _, skill := range skills {
		files = append(files, filepath.Join("skills", skill, "SKILL.md"))
	}
	return files
}

// Plugin is the plugin of aip's skills while the folder holds aip at Version, as Bin says; false otherwise. A harness that takes a plugin folder per session is started with it, so its session lists them and nothing is written into the user's own skills folders (#315).
func (f Folder) Plugin() (string, bool) {
	if _, ok := f.Bin(); !ok {
		return "", false
	}
	return f.plugin(), true
}

// Ensure installs aip at Version into the folder unless it holds it already and its aip states it, and keeps the outcome. A failed install is logged and leaves no folder.
func (f Folder) Ensure() State {
	unlock, err := f.lock()
	if err != nil {
		state := State{Missing: failedPrefix + err.Error()}
		if f.Log != nil {
			f.Log(state.Missing)
		}
		return state
	}
	defer unlock()
	if _, ok := f.Bin(); ok && f.states(filepath.Join(f.bin(), "aip")) {
		return f.State()
	}
	state := f.install()
	if state.Missing != "" && f.Log != nil {
		f.Log(state.Missing)
	}
	f.keep(state)
	return state
}

// lock waits until no other process, nor this one, installs into the folder, and holds it so: init and upgrade run beside the service, each its own process. The lock file lies beside the folder, which an install removes.
func (f Folder) lock() (func(), error) {
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(f.Path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		_ = file.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
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
		return State{Missing: failedPrefix + err.Error()}
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
	if err := f.linkCommands(); err != nil {
		return err
	}
	return f.installSkills(filepath.Join(venv, "bin", "aip"))
}

// manifest is the plugin of aip's skills as Claude Code reads it.
type manifest struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
}

// installSkills writes aip's own skills, as `aip skill install --path` writes them, into the plugin's skills folder, beside the plugin's manifest. aip also keeps a record of them in its home's .aip: its home, and every XDG folder, is the folder's own aip-home, so nothing is written into the user's.
func (f Folder) installSkills(aip string) error {
	home := filepath.Join(f.Path, "aip-home")
	env := []string{"HOME=" + home}
	for variable, folder := range map[string]string{"XDG_CONFIG_HOME": ".config", "XDG_CACHE_HOME": ".cache", "XDG_DATA_HOME": filepath.Join(".local", "share"), "XDG_STATE_HOME": filepath.Join(".local", "state")} {
		env = append(env, variable+"="+filepath.Join(home, folder))
	}
	if _, err := run(installWait, env, aip, "skill", "install", "--path", filepath.Join(f.plugin(), "skills")); err != nil {
		return err
	}
	text, err := json.Marshal(manifest{Name: "aip", Version: Version, Description: "aip " + Version + "'s own skills, aip-compile and aip-runtime, as aip skill install writes them"})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(f.plugin(), ".claude-plugin"), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(f.plugin(), ".claude-plugin", "plugin.json"), append(text, '\n'), 0o644)
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
