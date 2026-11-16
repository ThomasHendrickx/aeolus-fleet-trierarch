package cli

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// repositoryChoice keeps validation separate from cloning, so invalid input creates no clones.
type repositoryChoice struct {
	name string
	path string
	url  string
}

func repositoryListFlag(values map[string]string) []string {
	value, ok := values["--repositories"]
	if !ok {
		return nil
	}
	return splitRepositories(value)
}

func splitRepositories(value string) []string {
	return strings.Split(strings.ReplaceAll(strings.TrimSpace(value), ";", ","), ",")
}

func hasRepositoryChoice(flags Flags) bool {
	return flags.Repositories != nil || flags.RepositoriesIn != "" || flags.IsNoRepositories
}

func repositoryPath(written, home string) (string, error) {
	if written == "~" || strings.HasPrefix(written, "~/") {
		written = home + written[1:]
	}
	return filepath.Abs(written)
}

func repositoryURL(written string) bool {
	return strings.Contains(written, "://") || (!filepath.IsAbs(written) && strings.Contains(written, ":") && !strings.HasPrefix(written, "./") && !strings.HasPrefix(written, "../"))
}

func repositoryName(written string) string {
	if parsed, err := url.Parse(written); err == nil && parsed.Scheme != "" && parsed.Host != "" {
		written = parsed.Path
	}
	written = strings.TrimRight(written, "/")
	if _, after, ok := strings.Cut(written, ":"); ok && !strings.Contains(written, "://") {
		written = after
	}
	return strings.TrimSuffix(path.Base(written), ".git")
}

func isGitRepository(ctx context.Context, folder string) bool {
	// A directory inside a checkout is not itself a repository. Worktrees have a .git file.
	if _, err := os.Stat(filepath.Join(folder, ".git")); err != nil {
		return false
	}
	return exec.CommandContext(ctx, "git", "-C", folder, "rev-parse", "--git-dir").Run() == nil
}

func repositoryChoices(ctx context.Context, flags Flags, current config.Configuration, home string) ([]repositoryChoice, error) {
	count := 0
	if flags.Repositories != nil {
		count++
	}
	if flags.RepositoriesIn != "" {
		count++
	}
	if flags.IsNoRepositories {
		count++
	}
	if count > 1 {
		return nil, errors.New("choose only one of --repositories, --repositories-in or --no-repositories")
	}
	if flags.IsNoRepositories {
		return nil, nil
	}
	written := flags.Repositories
	if flags.RepositoriesIn != "" {
		folder, err := repositoryPath(flags.RepositoriesIn, home)
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(folder)
		if err != nil {
			return nil, fmt.Errorf("read a folder of repositories %s: %w", folder, err)
		}
		written = []string{}
		for _, entry := range entries {
			candidate := filepath.Join(folder, entry.Name())
			if isGitRepository(ctx, candidate) {
				written = append(written, candidate)
			}
		}
	}
	cloneInto := flags.CloneInto
	if cloneInto == "" {
		cloneInto = filepath.Join(home, "repositories")
	}
	cloneInto, err := repositoryPath(cloneInto, home)
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	var choices []repositoryChoice
	for _, entry := range written {
		entry = strings.TrimSpace(entry)
		choice := repositoryChoice{}
		if repositoryURL(entry) {
			choice.name, choice.url = repositoryName(entry), entry
			choice.path = filepath.Join(cloneInto, choice.name)
		} else {
			choice.path, err = repositoryPath(entry, home)
			if err != nil {
				return nil, err
			}
			choice.name = filepath.Base(choice.path)
			if entry == "" {
				return nil, errors.New("an empty entry is not a git repository")
			}
			if !isGitRepository(ctx, choice.path) {
				return nil, fmt.Errorf("%s is not a git repository", shown(choice.path, home))
			}
		}
		if !namePattern.MatchString(choice.name) || len(choice.name) > nameMaxLength {
			return nil, fmt.Errorf("%s has invalid repository name %q: lowercase letters, digits, dots, underscores and hyphens, at most %d characters", entry, choice.name, nameMaxLength)
		}
		if names[choice.name] {
			return nil, fmt.Errorf("%s: repository name %s is given twice", entry, choice.name)
		}
		names[choice.name] = true
		if held, ok := current.Repositories[choice.name]; ok && held.Path != choice.path {
			return nil, fmt.Errorf("%s: repository name %s names %s already", entry, choice.name, held.Path)
		}
		if held, ok := current.Folders[choice.name]; ok {
			return nil, fmt.Errorf("%s: name %s names folder %s already", entry, choice.name, held.Path)
		}
		choices = append(choices, choice)
	}
	return choices, nil
}

func cloneRepository(ctx context.Context, choice repositoryChoice) (bool, error) {
	if _, err := os.Stat(choice.path); err == nil {
		output, err := exec.CommandContext(ctx, "git", "-C", choice.path, "remote", "get-url", "origin").CombinedOutput()
		origin := strings.TrimSpace(string(output))
		if err == nil && origin == choice.url && isGitRepository(ctx, choice.path) {
			return false, nil
		}
		if err != nil {
			return false, fmt.Errorf("%s: clone destination %s has no matching origin: %s", choice.url, choice.path, origin)
		}
		return false, fmt.Errorf("%s: clone destination %s has different origin %s", choice.url, choice.path, origin)
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(choice.path), 0o755); err != nil {
		return false, err
	}
	output, err := exec.CommandContext(ctx, "git", "clone", "--", choice.url, choice.path).CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("clone %s: %w: %s", choice.url, err, strings.TrimSpace(string(output)))
	}
	return true, nil
}

const workspacesCopy = `For a repository, each ship gets its own git worktree.
A folder used as it is is shared: a session can change its existing files.
These choices select workspaces; they do not sandbox a session's access.`

const repositorySourcesCopy = `Add repositories from:
  1. Local repository paths or git URLs
  2. A folder containing git repositories (direct children only)
  3. Skip adding repositories`

const repositorySourcesHelp = `1 adds the git repositories you list, local paths or git URLs.
2 adds each git repository directly inside one folder.
3 adds none; repositories already set up stay. Default: 3.`

const addFolderHelp = `A session uses the folder directly, without making a git worktree.
Other sessions or people using it see changes to the same files.
Choose No if you only want the repositories above. Default: No.`

const folderNameCopy = `A name uses lowercase letters, digits, dots, underscores or hyphens,
starts with a letter or digit, and has at most 100 characters.`

const listPrompt = "Local paths or git URLs (comma or semicolon separated): "

// askRepositories asks where repositories come from until the answer can be used, and answers the choices it gives.
func (i Init) askRepositories(ctx context.Context, flags Flags, current config.Configuration, home string, cloneInto string, w wizard) ([]repositoryChoice, error) {
	w.say("", repositorySourcesCopy)
	var source string
	for {
		var err error
		if source, err = w.ask("Choose [3]: ", repositorySourcesHelp); err != nil {
			return nil, err
		}
		if source == "" || source == "1" || source == "2" || source == "3" {
			break
		}
		w.say("Choose 1, 2 or 3, or ? for help.")
	}
	flags.Repositories, flags.RepositoriesIn, flags.IsNoRepositories = nil, "", false
	switch source {
	case "", "3":
		return nil, nil
	case "1":
		where := "Git URLs are cloned to ~/repositories unless --clone-into sets another\nfolder. Local repositories stay where they are."
		if flags.CloneInto != "" {
			where = "Git URLs are cloned to " + shown(cloneInto, home) + ".\nLocal repositories stay where they are."
		}
		w.say(where)
		help := "Enter local git repository paths or git URLs, separated by commas or\nsemicolons. " + where
		for {
			value, err := w.ask(listPrompt, help)
			if err != nil {
				return nil, err
			}
			flags.Repositories = splitRepositories(value)
			choices, err := repositoryChoices(ctx, flags, current, home)
			if err == nil {
				return choices, nil
			}
			w.say(err.Error()+".", "Enter a local git repository path or a git URL, or ? for help.")
		}
	}
	for {
		value, err := w.ask("Path to a folder of repositories: ", "Enter a folder: each git repository directly inside it is added.")
		if err != nil {
			return nil, err
		}
		flags.RepositoriesIn = value
		if value == "" {
			w.say("Enter the path of a folder, or ? for help.")
			continue
		}
		choices, err := repositoryChoices(ctx, flags, current, home)
		if err == nil {
			return choices, nil
		}
		w.say(err.Error()+".", "Enter the path of a folder, or ? for help.")
	}
}

// selectRepositories is part 2: the repositories, each a worktree per ship, and the folders used as they are. Invalid answers are asked again; invalid flags stop before registration.
func (i Init) selectRepositories(ctx context.Context, flags Flags, current config.Configuration, w wizard, canAsk bool) (map[string]config.Repository, map[string]config.Folder, map[string]bool, error) {
	home := i.home()
	w.part(2)
	w.say(workspacesCopy)
	var existing []string
	for _, name := range slices.Sorted(maps.Keys(current.Repositories)) {
		existing = append(existing, "repository "+name+": "+shown(current.Repositories[name].Path, home))
	}
	for _, name := range slices.Sorted(maps.Keys(current.Folders)) {
		existing = append(existing, "folder "+name+": "+shown(current.Folders[name].Path, home))
	}
	if len(existing) > 0 {
		w.say("Already set up, and kept: " + strings.Join(existing, "; ") + ".")
	}
	cloneInto := flags.CloneInto
	if cloneInto == "" {
		cloneInto = filepath.Join(home, "repositories")
	}
	cloneInto, err := repositoryPath(cloneInto, home)
	if err != nil {
		return nil, nil, nil, stoppedBeforeRegistration(err)
	}
	var choices []repositoryChoice
	isAsked := !hasRepositoryChoice(flags) && !flags.IsYes
	switch {
	case isAsked && !canAsk:
		return nil, nil, nil, stopped(fmt.Sprintf("No terminal to ask on: init needs %s.", strings.Join(i.missingInitFlags(flags), ", ")), notJoinedBeforeRegistration, "Add the missing flags, then run your setup line again.")
	case isAsked:
		if choices, err = i.askRepositories(ctx, flags, current, home, cloneInto, w); err != nil {
			return nil, nil, nil, err
		}
	default:
		if choices, err = repositoryChoices(ctx, flags, current, home); err != nil {
			return nil, nil, nil, stoppedBeforeRegistration(err)
		}
		switch {
		case flags.IsNoRepositories || (len(choices) == 0 && flags.RepositoriesIn == ""):
			w.say(fromTheSetupLine("no repositories added"))
		case len(choices) == 0:
			w.say(fromTheSetupLine("no git repository in " + flags.RepositoriesIn))
		}
	}
	repositories := maps.Clone(current.Repositories)
	cloned := map[string]bool{}
	for _, choice := range choices {
		if choice.url != "" {
			w.say(fmt.Sprintf("Cloning %s to %s...", choice.url, shown(choice.path, home)))
			wasCloned, err := cloneRepository(ctx, choice)
			if err != nil {
				return nil, nil, nil, stopped(err.Error()+".", notJoinedBeforeRegistration, "Repositories cloned before it remain.", "Fix the reported cause, then run your setup line again.")
			}
			cloned[choice.name] = wasCloned
		}
		repository := repositories[choice.name]
		repository.Path = choice.path
		repositories[choice.name] = repository
		if isAsked {
			w.say(fmt.Sprintf("Added repository %s: %s", choice.name, shown(choice.path, home)))
		} else {
			w.say(fromTheSetupLine(fmt.Sprintf("repository %s: %s", choice.name, shown(choice.path, home))))
		}
	}
	folders, err := i.selectFolders(flags, current, repositories, w, canAsk)
	if err != nil {
		return nil, nil, nil, err
	}
	if len(repositories) == 0 && len(folders) == 0 {
		w.say("No workspace: this computer cannot crew a request until you add a repository or folder.")
	}
	return repositories, folders, cloned, nil
}

func (i Init) home() string {
	if i.HomeDirectory != "" {
		return i.HomeDirectory
	}
	return filepath.Dir(filepath.Dir(i.Paths.Home))
}

// folderPath is a folder's path as written, made absolute; a path that names no folder is refused.
func folderPath(written string, home string) (string, error) {
	path, err := repositoryPath(written, home)
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(path); written == "" || err != nil || !info.IsDir() {
		return "", fmt.Errorf("%s is not a folder", written)
	}
	return path, nil
}

// folderNameRefusal says why a folder cannot take name, given the repositories and folders that hold names already; empty when it can.
func folderNameRefusal(name string, repositories map[string]config.Repository, folders map[string]config.Folder) string {
	if !namePattern.MatchString(name) || len(name) > nameMaxLength {
		return name + " is not a valid name."
	}
	if _, ok := repositories[name]; ok {
		return name + " names repository " + name + " already: choose a different name."
	}
	if _, ok := folders[name]; ok {
		return name + " names folder " + name + " already: choose a different name."
	}
	return ""
}

// checkedFolderFlags are the folders the setup line names, refused when a name or path cannot be used.
func checkedFolderFlags(flags Flags, home string) (map[string]config.Folder, error) {
	if flags.IsNoFolders && len(flags.Folders) > 0 {
		return nil, errors.New("choose only one of --folder or --no-folders")
	}
	given := map[string]config.Folder{}
	for _, folder := range flags.Folders {
		if _, ok := given[folder.Name]; ok {
			return nil, fmt.Errorf("--folder %s: %s is given twice", folder.Name, folder.Name)
		}
		if !namePattern.MatchString(folder.Name) || len(folder.Name) > nameMaxLength {
			return nil, fmt.Errorf("--folder %s: %s is not a valid name; %s", folder.Name, folder.Name, strings.ReplaceAll(folderNameCopy, "\n", " "))
		}
		path, err := folderPath(folder.Path, home)
		if err != nil {
			return nil, fmt.Errorf("--folder %s: %w", folder.Name, err)
		}
		given[folder.Name] = config.Folder{Path: path}
	}
	return given, nil
}

// selectFolders adds the folders used as they are: from the setup line, or asked one at a time until the person adds no more. Folders already set up are kept.
func (i Init) selectFolders(flags Flags, current config.Configuration, repositories map[string]config.Repository, w wizard, canAsk bool) (map[string]config.Folder, error) {
	home := i.home()
	folders := maps.Clone(current.Folders)
	if folders == nil {
		folders = map[string]config.Folder{}
	}
	if len(flags.Folders) > 0 || flags.IsNoFolders {
		given, err := checkedFolderFlags(flags, home)
		if err != nil {
			return nil, stoppedBeforeRegistration(err)
		}
		if len(given) == 0 {
			w.say(fromTheSetupLine("no folders added"))
		}
		for _, folder := range flags.Folders {
			if refusal := folderNameRefusal(folder.Name, repositories, nil); refusal != "" {
				return nil, stoppedBeforeRegistration(errors.New("--folder " + folder.Name + ": " + strings.TrimSuffix(refusal, ".")))
			}
			if held, ok := folders[folder.Name]; ok && held.Path != given[folder.Name].Path {
				return nil, stoppedBeforeRegistration(fmt.Errorf("--folder %s: %s names folder %s already", folder.Name, folder.Name, shown(held.Path, home)))
			}
			folders[folder.Name] = given[folder.Name]
			w.say(fromTheSetupLine(fmt.Sprintf("folder %s: %s", folder.Name, shown(given[folder.Name].Path, home))))
		}
		return folders, nil
	}
	if flags.IsYes || !canAsk {
		return folders, nil
	}
	for {
		w.say("")
		isAdding, err := w.yes("Add a folder used as it is?", addFolderHelp, false)
		if err != nil || !isAdding {
			return folders, err
		}
		w.say(folderNameCopy)
		var name string
		for {
			if name, err = w.ask("Folder name: ", folderNameCopy+"\nThe name tells this folder apart from your other repositories and folders."); err != nil {
				return nil, err
			}
			refusal := folderNameRefusal(name, repositories, folders)
			if refusal == "" {
				break
			}
			w.say(refusal)
		}
		var path string
		for {
			written, err := w.ask("Folder path: ", "Enter the folder's path, such as ~/notes. Sessions use it as it is.")
			if err != nil {
				return nil, err
			}
			if path, err = folderPath(written, home); err == nil {
				break
			}
			w.say(err.Error() + ".")
		}
		folders[name] = config.Folder{Path: path}
		w.say(fmt.Sprintf("Added folder %s: %s", name, shown(path, home)))
	}
}
