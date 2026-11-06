package workspace

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// A ship's folder is its session's to write, `.git` and its config included, and with sessions in containers a session runs
// apart from the host (docs/trierarch.md, "Session runtime"). So the host's git calls in a ship's folder ignore the folder's own
// config where it names a program for git to run: git runs no hook, in a folder or in the config, no fsmonitor, no filter, diff or merge driver, no check of a signature, and no
// command for a transport, pager, editor or credential the folder's config names, and takes no optional lock, and fetches no object the folder lacks. No filter runs, the
// machine's own included, as the folder's attributes may name it, but in a fresh clone the trierarch just made, which no session
// touched yet. They go through inFolder, so no call can leave one of these in
// force. Otherwise the machine's own config (global and system) applies as before. A folder whose config names a program for
// git-lfs, which reads that config itself, is not read. Git is
// pointed at no folder but the ship's own: a folder whose config sets core.worktree is not read, and a clone is read only
// through its own `.git` folder, with its own objects alone (inClone): a clone whose config names a remote to fetch missing objects from
// is not read. A folder that is not read is refused with why (RefusedError), so what it holds is not
// known, as is one where a git call does not end within its time limit (timeLimit), as what git waits on may never come.

// timeLimit is how long the host's git calls in a ship's folder run, together, before they are ended and the folder not read.
var timeLimit = time.Minute

// freshTimeLimit is how long the host's git calls in a fresh clone run: its fetch and checkout may download what the machine's
// filters fetch, as git-lfs's.
const freshTimeLimit = 10 * time.Minute

// reading is how the host reads a ship's folder: as a clone, whose config names no remote to fetch missing objects from, or not; as
// a fresh clone the trierarch just made, which no session touched yet, so its checkout runs the filters the machine's own config
// defines, or not; and within what time limit, for its git calls together.
type reading struct {
	isClone bool
	isFresh bool
	limit   time.Duration
}

// waitDelay is how long a git call ended at its time limit is waited for to close its output.
const waitDelay = time.Second

// command is git run with its arguments, ended when the context is done.
func command(ctx context.Context, args ...string) *exec.Cmd {
	command := exec.CommandContext(ctx, "git", args...)
	command.WaitDelay = waitDelay
	return command
}

// endedAt is the refusal of a folder whose git call ran past its time limit, or nil when it did not.
func endedAt(ctx context.Context, limit time.Duration, folder string, action string) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &RefusedError{folder, fmt.Sprintf("git %s did not end within %d seconds", action, int(limit.Seconds()))}
	}
	return nil
}

// RefusedError is a folder the host does not read, with why.
type RefusedError struct {
	Folder string
	Reason string
}

func (e *RefusedError) Error() string {
	return fmt.Sprintf("will not read %s: %s", e.Folder, e.Reason)
}

// harmless are the values the host's git calls take in a ship's folder whatever its config says: no hooks in a folder, no fsmonitor,
// and no check of a commit's signature, which runs the machine's gpg, gpgsm or ssh-keygen.
var harmless = []override{{"core.fsmonitor", "false"}, {"core.hooksPath", "/dev/null"}, {"log.showSignature", "false"}}

// namesAProgram are the config variables that name a program git runs, by section, then by variable; a section of three-part
// names (`filter.<driver>.clean`) holds the variables of any subsection.
var namesAProgram = map[string]map[string]bool{
	"core":        {"sshcommand": true, "pager": true, "editor": true, "askpass": true, "gitproxy": true, "alternaterefscommand": true},
	"sequence":    {"editor": true},
	"diff":        {"external": true, "command": true, "textconv": true},
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

// neutralOf is the value that turns the variable off: no pager, else no program.
func neutralOf(name string) override {
	if section, _, _ := strings.Cut(name, "."); section == "pager" {
		return override{name, "false"}
	}
	return override{name, ""}
}

// filterOffOf is the filter driver a variable of a filter (`filter.<driver>.clean`) belongs to, running nothing and not required;
// none for another variable.
func filterOffOf(name string) []override {
	first := strings.Index(name, ".")
	last := strings.LastIndex(name, ".")
	if first < 0 || name[:first] != "filter" || last == first {
		return nil
	}
	driver := name[:last]
	return []override{{driver + ".process", ""}, {driver + ".clean", ""}, {driver + ".smudge", ""}, {driver + ".required", "false"}}
}

// noLazyFetch fetches no object the folder lacks, from any remote its config names to fetch missing objects from.
const noLazyFetch = "GIT_NO_LAZY_FETCH=1"

// isPromisor says whether the variable, as git lists it, makes a remote one git fetches missing objects from: a partial clone's, or
// any promisor remote.
func isPromisor(name string) bool {
	return name == "extensions.partialclone" || (strings.HasPrefix(name, "remote.") && strings.HasSuffix(name, ".promisor"))
}

// lfsPrograms are the sections of git-lfs's own config that name a program it runs, which git-lfs reads from the folder's config
// itself.
var lfsPrograms = []string{"lfs.extension.", "lfs.customtransfer."}

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
// folder whose config points git at another work tree is not read, nor a clone whose config names a remote to fetch missing objects
// from.
func overridesIn(ctx context.Context, folder string, located []string, as reading) ([]override, error) {
	listing := command(ctx, "-C", folder, "config", "--list", "--show-scope", "--name-only", "-z")
	listing.Env = append(append(os.Environ(), located...), noLazyFetch)
	listed, err := listing.Output()
	if refused := endedAt(ctx, as.limit, folder, "config"); refused != nil {
		return nil, refused
	}
	if err != nil {
		return nil, fmt.Errorf("git config failed in %s: %w", folder, err)
	}
	overrides := append([]override{}, harmless...)
	fields := bytes.Split(bytes.TrimSuffix(listed, []byte{0}), []byte{0})
	for i := 0; i+1 < len(fields); i += 2 {
		scope, name := string(fields[i]), string(fields[i+1])
		// Of every scope but a fresh clone's: the folder's attributes may name a filter the machine's own config defines, as git-lfs's.
		for _, off := range filterOffOf(name) {
			if (!as.isFresh || isTheFolders(scope)) && !slices.Contains(overrides, off) {
				overrides = append(overrides, off)
			}
		}
		if !isTheFolders(scope) {
			continue
		}
		if name == "core.worktree" {
			return nil, &RefusedError{folder, "its config sets core.worktree, which points git at another folder"}
		}
		if slices.ContainsFunc(lfsPrograms, func(section string) bool { return strings.HasPrefix(name, section) }) {
			return nil, &RefusedError{folder, "its config names a program for git-lfs: " + name}
		}
		if as.isClone && isPromisor(name) {
			return nil, &RefusedError{folder, "its config names a remote to fetch missing objects from: " + name}
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

// inFolder is git run in a ship's folder with the folder's own config naming no program, and only a local repository to fetch from. A
// folder whose `.git` is neither a file nor a folder, or whose own git folder (a worktree's, which its `.git` file names) is no folder
// or holds a link or a special file, is not read.
func inFolder(ctx context.Context, folder string, as reading, args ...string) (*exec.Cmd, error) {
	gitFolder, err := ownGitFolderOf(folder)
	if err != nil {
		return nil, err
	}
	if gitFolder != "" {
		if found, err := os.Lstat(gitFolder); err != nil || !found.IsDir() {
			return nil, &RefusedError{folder, "its .git names no folder of its own"}
		}
		irregular, err := irregularIn(gitFolder)
		if err != nil {
			return nil, err
		}
		if irregular != "" {
			return nil, &RefusedError{folder, irregular}
		}
	}
	return located(ctx, folder, nil, as, args)
}

// ownGitFolderOf is the folder's own git folder: its `.git` when that is a folder, else the one its `.git` file names; none without a
// `.git`.
func ownGitFolderOf(folder string) (string, error) {
	dotGit := filepath.Join(folder, ".git")
	found, err := os.Lstat(dotGit)
	if err != nil {
		return "", nil
	}
	if found.IsDir() {
		return dotGit, nil
	}
	if !found.Mode().IsRegular() {
		return "", &RefusedError{folder, "its .git is neither a file nor a folder of its own"}
	}
	content, err := os.ReadFile(dotGit)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", dotGit, err)
	}
	for _, line := range strings.Split(string(content), "\n") {
		if named, ok := strings.CutPrefix(line, "gitdir: "); ok && strings.TrimSpace(named) != "" {
			named = strings.TrimSpace(named)
			if !filepath.IsAbs(named) {
				named = filepath.Join(folder, named)
			}
			return named, nil
		}
	}
	return "", nil
}

// inClone is git run in a ship's clone as in its folder, through the clone's own `.git` folder and with the clone as its work tree,
// whatever the clone says: a `.git` that is a file or a link, that names another folder's in its commondir, that holds a link, that
// names another repository's objects in its alternates, or whose config includes a file from outside it, would point git at another
// folder, so such a clone is not read; nor one whose `.git` holds a special file, such as a named pipe, which git may wait on forever.
func inClone(ctx context.Context, clone string, as reading, args ...string) (*exec.Cmd, error) {
	gitFolder := filepath.Join(clone, ".git")
	if found, err := os.Lstat(gitFolder); err != nil || !found.IsDir() {
		return nil, &RefusedError{clone, "its .git is no folder of its own"}
	}
	if _, err := os.Lstat(filepath.Join(gitFolder, "commondir")); err == nil {
		return nil, &RefusedError{clone, "its .git names another git folder in its commondir"}
	}
	irregular, err := irregularIn(gitFolder)
	if err != nil {
		return nil, err
	}
	if irregular != "" {
		return nil, &RefusedError{clone, irregular}
	}
	if _, err := os.Lstat(filepath.Join(gitFolder, "objects", "info", "alternates")); err == nil {
		return nil, &RefusedError{clone, "its .git names another repository's objects in objects/info/alternates"}
	}
	include, err := includeOutside(ctx, gitFolder, as.limit)
	if err != nil {
		return nil, err
	}
	if include != "" {
		return nil, &RefusedError{clone, "its config includes a file outside its .git: " + include}
	}
	return located(ctx, clone, []string{"GIT_DIR=" + gitFolder, "GIT_WORK_TREE=" + clone}, as, args)
}

// irregularIn is why the first entry in the git folder that is neither a regular file nor a folder is not read, by its path in it,
// or none: a link would lead git out of it, and git reading a special file, such as a named pipe, may never end.
func irregularIn(gitFolder string) (string, error) {
	why := ""
	// WalkDir follows no link: one to a folder is a link it does not enter.
	err := filepath.WalkDir(gitFolder, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() || entry.IsDir() {
			return nil
		}
		inGit, err := filepath.Rel(gitFolder, path)
		if err != nil {
			return err
		}
		why = "its .git holds a special file: " + inGit
		if entry.Type()&fs.ModeSymlink != 0 {
			why = "its .git holds a link: " + inGit
		}
		return fs.SkipAll
	})
	if err != nil {
		return "", fmt.Errorf("list %s: %w", gitFolder, err)
	}
	return why, nil
}

// includes are the variables of a config file that include another, as git lists them.
const includes = `^include(if\..*)?\.path$`

// isIn says whether the path lies in the folder.
func isIn(folder string, path string) bool {
	inFolder, err := filepath.Rel(folder, path)
	return err == nil && inFolder != ".." && !strings.HasPrefix(inFolder, ".."+string(filepath.Separator))
}

// includeOutside is the first file the git folder's config includes from outside it, as the config names it, or that a file it
// includes includes in turn, or none: git would read it, and only what lies in the git folder is checked. A path from a home folder
// or git's own prefix is outside.
func includeOutside(ctx context.Context, gitFolder string, limit time.Duration) (string, error) {
	toRead := []string{filepath.Join(gitFolder, "config"), filepath.Join(gitFolder, "config.worktree")}
	read := map[string]bool{}
	for len(toRead) > 0 {
		file := toRead[0]
		toRead = toRead[1:]
		if _, err := os.Lstat(file); err != nil || read[file] {
			continue
		}
		read[file] = true
		listing := command(ctx, "config", "--file", file, "--null", "--get-regexp", includes)
		listing.Env = append(os.Environ(), noLazyFetch)
		listed, err := listing.Output()
		if refused := endedAt(ctx, limit, filepath.Dir(gitFolder), "config"); refused != nil {
			return "", refused
		}
		// None found answers 1.
		if exit := (*exec.ExitError)(nil); errors.As(err, &exit) && exit.ExitCode() == 1 {
			continue
		}
		if err != nil {
			return "", failedConfig(err)
		}
		for _, entry := range bytes.Split(bytes.TrimSuffix(listed, []byte{0}), []byte{0}) {
			_, value, _ := strings.Cut(string(entry), "\n")
			path := value
			if !filepath.IsAbs(path) {
				path = filepath.Join(filepath.Dir(file), value)
			}
			if strings.HasPrefix(value, "~") || strings.HasPrefix(value, "%(") || !isIn(gitFolder, path) {
				return value, nil
			}
			toRead = append(toRead, path)
		}
	}
	return "", nil
}

// failedConfig is why a git config call failed, as git said it.
func failedConfig(err error) error {
	if exit := (*exec.ExitError)(nil); errors.As(err, &exit) && len(exit.Stderr) > 0 {
		return fmt.Errorf("git config failed: %s", messageOf(string(exit.Stderr)))
	}
	return fmt.Errorf("git config failed: %w", err)
}

// located is git run in the folder, with where it finds its repository given in the environment when it is, read as it says.
func located(ctx context.Context, folder string, at []string, as reading, args []string) (*exec.Cmd, error) {
	overrides, err := overridesIn(ctx, folder, at, as)
	if err != nil {
		return nil, err
	}
	git := command(ctx, append([]string{"-C", folder}, args...)...)
	// Given in the environment rather than as -c, so a name holding an equals sign is taken whole.
	git.Env = append(append(os.Environ(), at...), noLazyFetch, "GIT_CONFIG_COUNT="+strconv.Itoa(len(overrides)), "GIT_ALLOW_PROTOCOL=file", "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0")
	for i, each := range overrides {
		git.Env = append(git.Env, "GIT_CONFIG_KEY_"+strconv.Itoa(i)+"="+each.name, "GIT_CONFIG_VALUE_"+strconv.Itoa(i)+"="+each.value)
	}
	return git, nil
}
