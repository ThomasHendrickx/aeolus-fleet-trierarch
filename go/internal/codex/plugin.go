package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
)

const (
	marketplace   = "aeolus-fleet"
	repository    = "ThomasHendrickx/aeolus-fleet-trierarch"
	pluginID      = "aeolus-fleet@aeolus-fleet"
	renamedPlugin = "aeolus@aeolus-fleet"
)

// ErrDeletesPluginData is the refusal of an upgrade on a Codex that would delete the plugin's data folder with its marketplace.
var ErrDeletesPluginData = errors.New("this Codex would delete the aeolus-fleet plugin's data, its log and the crew identities not yet moved to ~/.aeolus/crews, when its aeolus-fleet marketplace is removed: the upgrade leaves the marketplace as it is")

// Process is a process running on this machine: its pid, its program and when it started.
type Process struct {
	PID       int
	Program   string
	StartedAt time.Time
}

// PluginUpdate updates the aeolus-fleet plugin through Codex's own commands,
// from a release tag, as today's trierarch's upgrade does. Codex's
// marketplace is removed and added again at the tag, which keeps the plugin
// and its cache, once a throwaway Codex home proves this Codex keeps the
// plugin's data, its log and the crew identities not yet moved to
// ~/.aeolus/crews, when it is removed (#660); it changes nothing otherwise.
// Codex's plugin upgrade installs the new version and deletes every other
// version folder, so a Codex session still running on the old version would
// lose its plugin scripts: the version folders there before are kept aside and
// put back beside the new one, also when the upgrade fails. After an upgrade
// that succeeded, a version folder no running session can use is removed
// (#653): a session uses the newest version there was when it started, so a
// version is left behind once its next version came before every running
// Codex process, and the trierarch, started. A version counts from when the
// upgrade installed it.
type PluginUpdate struct {
	// Program is Codex's command, `codex` on the machine.
	Program string
	// Home is Codex's home: CODEX_HOME when it is set, else ~/.codex.
	Home string
	// Now is the clock.
	Now func() time.Time
	// Processes are the processes running on this machine now.
	Processes func(now time.Time) ([]Process, error)
	// TrierarchPID is the running trierarch's pid, 0 when none runs: it took its plugin scripts from the newest version when it started.
	TrierarchPID func() int
}

// PluginUpdateOf the user's home folder, and CODEX_HOME when it is not empty, with the trierarch's pid as trierarchPID says it.
func PluginUpdateOf(homeDirectory string, codexHome string, trierarchPID func() int) PluginUpdate {
	if codexHome == "" {
		codexHome = filepath.Join(homeDirectory, ".codex")
	}
	return PluginUpdate{Program: "codex", Home: codexHome, Now: time.Now, Processes: RunningProcesses, TrierarchPID: trierarchPID}
}

func (p PluginUpdate) cache() string {
	return filepath.Join(p.Home, "plugins", "cache", marketplace, "aeolus-fleet")
}

// commandTimeout bounds each Codex command, which reaches the network.
const commandTimeout = 5 * time.Minute

// run runs Codex with the arguments, in the Codex home given when it is not empty.
func run(program string, codexHome string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, program, args...)
	if codexHome != "" {
		command.Env = append(os.Environ(), "CODEX_HOME="+codexHome)
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("codex %s failed: %s: %w", strings.Join(args, " "), strings.TrimSpace(string(output)), err)
	}
	return nil
}

// Update installs the plugin of the release tag.
func (p PluginUpdate) Update(tag string) error {
	isKept, err := KeepsPluginData(p.Program)
	if err != nil {
		return err
	}
	if !isKept {
		return ErrDeletesPluginData
	}
	cache := p.cache()
	return keepingVersions(cache, func() error {
		// There may be no marketplace to remove: adding it says what is wrong.
		_ = run(p.Program, "", "plugin", "marketplace", "remove", marketplace)
		if err := run(p.Program, "", "plugin", "marketplace", "add", repository, "--ref", tag); err != nil {
			return err
		}
		if err := run(p.Program, "", "plugin", "marketplace", "upgrade", marketplace); err != nil {
			return err
		}
		// The marketplace upgrade updates an installed plugin only: with its cache folder emptied there is none to update (#1212).
		if len(versionsIn(cache)) == 0 {
			if err := run(p.Program, "", "plugin", "add", pluginID); err != nil {
				return err
			}
		}
		// Codex enables the renamed plugin until told otherwise, also once its marketplace entry is gone; removing one it lacks succeeds.
		return run(p.Program, "", "plugin", "remove", renamedPlugin)
	}, func(before []string) error {
		upgradedAt := p.Now()
		markInstalled(cache, before, upgradedAt)
		processes, err := p.Processes(upgradedAt)
		if err != nil {
			return err
		}
		removeUnused(cache, earliestStartOf(processes, p.TrierarchPID()))
		return nil
	})
}

// KeepsPluginData says whether Codex keeps the aeolus-fleet plugin's data
// folder, which holds its log and the crew identities not yet moved to
// ~/.aeolus/crews (decision 0015), when its aeolus-fleet marketplace is
// removed (#660). The Codex given installs an aeolus-fleet plugin of its own
// from a local aeolus-fleet marketplace in a throwaway CODEX_HOME, a mark goes
// in the plugin's data folder, and the marketplace is removed. The real Codex
// home is never touched. An error says what Codex said when it cannot run it.
func KeepsPluginData(program string) (bool, error) {
	folder, err := os.MkdirTemp("", "aeolus-codex-plugin-data-")
	if err != nil {
		return false, err
	}
	defer os.RemoveAll(folder)
	local := filepath.Join(folder, "marketplace")
	codexHome := filepath.Join(folder, "codex-home")
	files := map[string]string{
		filepath.Join(local, ".agents", "plugins", "marketplace.json"):                  `{"name":"aeolus-fleet","plugins":[{"name":"aeolus-fleet","source":{"source":"local","path":"./plugins/aeolus-fleet"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"}}]}`,
		filepath.Join(local, "plugins", "aeolus-fleet", ".codex-plugin", "plugin.json"): `{"name":"aeolus-fleet","version":"0.0.0","description":"The aeolus-fleet plugin data proof of aeolus-trierarch."}`,
	}
	for path, text := range files {
		if err := writeFile(path, text); err != nil {
			return false, err
		}
	}
	if err := os.Mkdir(codexHome, 0o700); err != nil {
		return false, err
	}
	if err := run(program, codexHome, "plugin", "marketplace", "add", local); err != nil {
		return false, err
	}
	if err := run(program, codexHome, "plugin", "add", pluginID); err != nil {
		return false, err
	}
	mark := filepath.Join(codexHome, "plugins", "data", plugin.DataFolder, "mark")
	if err := writeFile(mark, "kept\n"); err != nil {
		return false, err
	}
	if err := run(program, codexHome, "plugin", "marketplace", "remove", marketplace); err != nil {
		return false, err
	}
	text, err := os.ReadFile(mark)
	return err == nil && string(text) == "kept\n", nil
}

func writeFile(path string, text string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(text), 0o600)
}

var releaseVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// folders are the folders in the cache, none where it does not exist.
func folders(cache string) []string {
	entries, _ := os.ReadDir(cache)
	var names []string
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	return names
}

// versionsIn are the version folders in the cache, oldest version first.
func versionsIn(cache string) []string {
	versions := slices.DeleteFunc(folders(cache), func(name string) bool { return !releaseVersion.MatchString(name) })
	slices.SortFunc(versions, byVersion)
	return versions
}

// byVersion orders versions such as 0.9.0 and 0.10.0 by their numbers.
func byVersion(left string, right string) int {
	a, b := strings.Split(left, "."), strings.Split(right, ".")
	for index := range 3 {
		var x, y int
		if index < len(a) {
			x, _ = strconv.Atoi(a[index])
		}
		if index < len(b) {
			y, _ = strconv.Atoi(b[index])
		}
		if x != y {
			return x - y
		}
	}
	return 0
}

// keepingVersions runs upgrade with every folder in the cache kept aside, and puts back each one it deleted, with the time it came; then, once upgrade succeeded, runs after with the folders there before.
func keepingVersions(cache string, upgrade func() error, after func(before []string) error) error {
	before := folders(cache)
	aside, err := os.MkdirTemp("", "aeolus-plugin-versions-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(aside)
	came := map[string]time.Time{}
	for _, version := range before {
		info, err := os.Stat(filepath.Join(cache, version))
		if err != nil {
			return err
		}
		came[version] = info.ModTime()
		if err := copyTree(filepath.Join(cache, version), filepath.Join(aside, version)); err != nil {
			return err
		}
	}
	upgraded := upgrade()
	left := folders(cache)
	for _, version := range before {
		if slices.Contains(left, version) {
			continue
		}
		folder := filepath.Join(cache, version)
		if err := copyTree(filepath.Join(aside, version), folder); err != nil {
			return errors.Join(upgraded, err)
		}
		// The folder's time says when its version came.
		if err := os.Chtimes(folder, came[version], came[version]); err != nil {
			return errors.Join(upgraded, err)
		}
	}
	if upgraded != nil {
		return upgraded
	}
	return after(before)
}

// copyTree copies the folder to another path with the modes and times of its files.
func copyTree(from string, to string) error {
	return filepath.WalkDir(from, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(from, path)
		if err != nil {
			return err
		}
		target := filepath.Join(to, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		switch {
		case entry.IsDir():
			return os.MkdirAll(target, info.Mode().Perm()|0o700)
		case info.Mode()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		}
		if err := copyFile(path, target, info.Mode().Perm()); err != nil {
			return err
		}
		return os.Chtimes(target, info.ModTime(), info.ModTime())
	})
}

func copyFile(from string, to string, mode fs.FileMode) error {
	source, err := os.Open(from)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(target, source); err != nil {
		target.Close()
		return err
	}
	return target.Close()
}

// markInstalled marks each version folder the upgrade installed with the time it did, whatever times Codex gave its files.
func markInstalled(cache string, before []string, now time.Time) {
	for _, version := range folders(cache) {
		if !slices.Contains(before, version) {
			_ = os.Chtimes(filepath.Join(cache, version), now, now)
		}
	}
}

// startMargin is how long after a version came a start may still have found the one before: ps says elapsed time in whole seconds, and a session takes a moment to read its plugin.
const startMargin = time.Minute

// removeUnused removes each version folder whose next version came before the earliest start, every older one when nothing runs.
func removeUnused(cache string, earliestStart time.Time) {
	versions := versionsIn(cache)
	for index, version := range versions[:max(len(versions)-1, 0)] {
		next, err := os.Stat(filepath.Join(cache, versions[index+1]))
		if err != nil {
			continue
		}
		if earliestStart.IsZero() || !earliestStart.Before(next.ModTime().Add(startMargin)) {
			_ = os.RemoveAll(filepath.Join(cache, version))
		}
	}
}

// earliestStartOf is the earliest start of a process that may use a Codex plugin version, a Codex one or the trierarch; zero when none runs.
func earliestStartOf(processes []Process, trierarchPID int) time.Time {
	var earliest time.Time
	for _, process := range processes {
		if filepath.Base(process.Program) != "codex" && (trierarchPID == 0 || process.PID != trierarchPID) {
			continue
		}
		if earliest.IsZero() || process.StartedAt.Before(earliest) {
			earliest = process.StartedAt
		}
	}
	return earliest
}

// psLine is a line of `ps -A -o pid=,etime=,comm=`: the elapsed time is `[[days-]hours:]minutes:seconds`.
var psLine = regexp.MustCompile(`^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.+)$`)

// processesOf are the processes ps says, each started its elapsed time before now.
func processesOf(said string, now time.Time) []Process {
	var processes []Process
	for _, line := range strings.Split(said, "\n") {
		match := psLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		number := func(index int) time.Duration {
			value, _ := strconv.Atoi(match[index])
			return time.Duration(value)
		}
		pid, _ := strconv.Atoi(match[1])
		elapsed := number(2)*24*time.Hour + number(3)*time.Hour + number(4)*time.Minute + number(5)*time.Second
		processes = append(processes, Process{PID: pid, Program: strings.TrimSpace(match[6]), StartedAt: now.Add(-elapsed)})
	}
	return processes
}

// RunningProcesses are the processes running on this machine now, as macOS and Linux ps both say them.
func RunningProcesses(now time.Time) ([]Process, error) {
	said, err := exec.Command("ps", "-A", "-o", "pid=,etime=,comm=").Output()
	if err != nil {
		return nil, fmt.Errorf("ps -A -o pid=,etime=,comm= failed: %w", err)
	}
	return processesOf(string(said), now), nil
}

// PluginVersion is the version the plugin's manifest at its root says, empty when it says none.
func PluginVersion(root string) string {
	text, err := os.ReadFile(filepath.Join(root, ".codex-plugin", "plugin.json"))
	if err != nil {
		return ""
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(text, &manifest) != nil {
		return ""
	}
	return manifest.Version
}
