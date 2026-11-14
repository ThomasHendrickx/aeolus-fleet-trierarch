package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
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
			if entry == "" || !isGitRepository(ctx, choice.path) {
				return nil, fmt.Errorf("%s is no git repository", entry)
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

func cloneRepository(ctx context.Context, choice repositoryChoice) error {
	if _, err := os.Stat(choice.path); err == nil {
		output, err := exec.CommandContext(ctx, "git", "-C", choice.path, "remote", "get-url", "origin").CombinedOutput()
		origin := strings.TrimSpace(string(output))
		if err == nil && origin == choice.url && isGitRepository(ctx, choice.path) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("%s: clone destination %s has no matching origin: %s", choice.url, choice.path, origin)
		}
		return fmt.Errorf("%s: clone destination %s has different origin %s", choice.url, choice.path, origin)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(choice.path), 0o755); err != nil {
		return err
	}
	output, err := exec.CommandContext(ctx, "git", "clone", "--", choice.url, choice.path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("clone %s: %w: %s", choice.url, err, strings.TrimSpace(string(output)))
	}
	return nil
}

var errRepositoryAnswer = errors.New("invalid repositories answer")

func askRepositories(reader *bufio.Reader, terminal io.Writer, flags Flags) (Flags, error) {
	if _, err := fmt.Fprintln(terminal, "Repositories: 1) a list of local paths or git URLs, 2) a folder of repositories, 3) skip [3]"); err != nil {
		return flags, err
	}
	answer, err := reader.ReadString('\n')
	if err != nil {
		return flags, fmt.Errorf("read repositories answer: %w", err)
	}
	flags.Repositories, flags.RepositoriesIn, flags.IsNoRepositories = nil, "", false
	switch strings.TrimSpace(answer) {
	case "", "3":
		flags.IsNoRepositories = true
	case "1", "2":
		question := "Local paths or git URLs (comma or semicolon separated): "
		if strings.TrimSpace(answer) == "2" {
			question = "Path to a folder of repositories: "
		}
		if _, err := fmt.Fprint(terminal, question); err != nil {
			return flags, err
		}
		value, err := reader.ReadString('\n')
		if err != nil {
			return flags, fmt.Errorf("read repositories answer: %w", err)
		}
		if strings.TrimSpace(answer) == "1" {
			flags.Repositories = splitRepositories(value)
		} else {
			flags.RepositoriesIn = strings.TrimSpace(value)
			if flags.RepositoriesIn == "" {
				return flags, fmt.Errorf("%w: a folder of repositories needs a path", errRepositoryAnswer)
			}
		}
	default:
		return flags, fmt.Errorf("%w: choose 1, 2 or 3", errRepositoryAnswer)
	}
	return flags, nil
}

func (i Init) selectRepositories(ctx context.Context, flags Flags, current config.Configuration, reader *bufio.Reader, terminal io.Writer) (map[string]config.Repository, error) {
	isWizard := !hasRepositoryChoice(flags) && !flags.IsYes
	if isWizard && reader == nil {
		return nil, fmt.Errorf("no terminal: init needs %s", strings.Join(i.missingInitFlags(flags), ", "))
	}
	home := i.HomeDirectory
	if home == "" {
		home = filepath.Dir(filepath.Dir(i.Paths.Home))
	}
	var choices []repositoryChoice
	for {
		var err error
		if isWizard {
			flags, err = askRepositories(reader, terminal, flags)
			if err != nil && !errors.Is(err, errRepositoryAnswer) {
				return nil, err
			}
		}
		if err == nil {
			choices, err = repositoryChoices(ctx, flags, current, home)
		}
		if err == nil {
			break
		}
		if !isWizard {
			return nil, err
		}
		if _, writeErr := fmt.Fprintln(terminal, err); writeErr != nil {
			return nil, writeErr
		}
	}
	repositories := maps.Clone(current.Repositories)
	for _, choice := range choices {
		if choice.url != "" {
			if err := cloneRepository(ctx, choice); err != nil {
				return nil, err
			}
		}
		repository := repositories[choice.name]
		repository.Path = choice.path
		repositories[choice.name] = repository
	}
	return repositories, nil
}
