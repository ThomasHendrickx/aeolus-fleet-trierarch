package cli

import (
	"errors"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func aGitRepository(t *testing.T, folder string) string {
	t.Helper()
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("git", "init", "--quiet", folder).CombinedOutput(); err != nil {
		t.Fatalf("git init: %s: %v", output, err)
	}
	return folder
}

func TestInitRepositoryFlags(t *testing.T) {
	for _, mode := range []string{"list", "folder of repositories", "skip", "clone default", "clone into"} {
		t.Run(mode, func(t *testing.T) {
			machine, _, _ := aMain(t)
			root := t.TempDir()
			web := aGitRepository(t, filepath.Join(root, "web"))
			api := aGitRepository(t, filepath.Join(root, "api"))
			aGitRepository(t, filepath.Join(root, "nested", "deeper"))
			words := setupWords()
			want := map[string]string{}
			switch mode {
			case "list":
				words = append(words, "--repositories", " "+web+"; "+api+" ")
				want["web"], want["api"] = web, api
			case "folder of repositories":
				words = append(words, "--repositories-in", root)
				want["web"], want["api"] = web, api
			case "skip":
				words = append(words, "--no-repositories")
			case "clone default", "clone into":
				destination := filepath.Join(machine.HomeDirectory, "repositories")
				words = append(words, "--repositories", "file://"+web)
				if mode == "clone into" {
					destination = filepath.Join(root, "clones")
					words = append(words, "--clone-into", destination)
				}
				want["web"] = filepath.Join(destination, "web")
			}
			output, code := Main(words, machine)
			if code != 0 {
				t.Fatalf("init = %d, %s", code, output)
			}
			got, err := config.Load(pathsOf(machine).Config)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Repositories) != len(want) || len(got.Folders) != 0 {
				t.Fatalf("places = %+v, %+v, want %v repositories only", got.Repositories, got.Folders, want)
			}
			for name, path := range want {
				if got.Repositories[name].Path != path {
					t.Errorf("%s = %+v, want %s", name, got.Repositories[name], path)
				}
				if _, err := os.Stat(filepath.Join(path, ".git")); err != nil {
					t.Errorf("%s not cloned: %v", path, err)
				}
			}
		})
	}
}

func TestInitInvalidRepositoriesStopBeforeRegistration(t *testing.T) {
	for _, mode := range []string{"not git", "name clash", "failed clone", "missing selection"} {
		t.Run(mode, func(t *testing.T) {
			machine, _, fleet := aMain(t)
			root := t.TempDir()
			words := setupWords()
			want := ""
			switch mode {
			case "not git":
				words = append(words, "--repositories", root)
				want = root
			case "name clash":
				first := aGitRepository(t, filepath.Join(root, "one", "web"))
				second := aGitRepository(t, filepath.Join(root, "two", "web"))
				words = append(words, "--repositories", first+","+second)
				want = "web"
			case "failed clone":
				want = "file://" + filepath.Join(root, "missing.git")
				words = append(words, "--repositories", want, "--clone-into", filepath.Join(root, "clones"))
			case "missing selection":
				want = "--repositories"
				words = words[:len(words)-1]
			}
			output, code := Main(words, machine)
			if code != 1 || !strings.Contains(output, want) {
				t.Fatalf("init = %d, %s, want error naming %s", code, output, want)
			}
			if len(fleet.registered) != 0 {
				t.Fatal("registered before repositories were ready")
			}
			if mode == "failed clone" && !strings.Contains(output, "does not appear to be a git repository") {
				t.Fatalf("missing git's reason: %s", output)
			}
		})
	}
}

func TestInitRepositoryWizardAsksAgain(t *testing.T) {
	for _, mode := range []string{"not git", "name clash", "folder of repositories", "skip", "harnesses then repositories"} {
		t.Run(mode, func(t *testing.T) {
			machine, _, _ := aMain(t)
			root := t.TempDir()
			web := aGitRepository(t, filepath.Join(root, "web"))
			other := aGitRepository(t, filepath.Join(root, "other", "web"))
			input := "1\n" + root + "\n1\n" + web + "\n"
			count := 1
			words := setupWords()
			words = append(words[:len(words)-1], "--unattended=")
			switch mode {
			case "name clash":
				input = "1\n" + web + "," + other + "\n1\n" + web + "\n"
			case "folder of repositories":
				input = "2\n" + root + "\n"
			case "skip":
				input = "3\n"
				count = 0
			case "harnesses then repositories":
				words = words[:len(words)-3]
				words = append(words, "--unattended=")
				input = "yes\nno\nno\n1\n" + web + "\n"
			}
			terminal := &scriptedTerminal{input: strings.NewReader(input)}
			machine.OpenTerminal = func() (io.ReadWriteCloser, error) { return terminal, nil }
			output, code := Main(words, machine)
			if code != 0 {
				t.Fatalf("init = %d, %s, terminal = %s", code, output, terminal.String())
			}
			got, err := config.Load(pathsOf(machine).Config)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Repositories) != count {
				t.Fatalf("repositories = %+v", got.Repositories)
			}
			if count == 1 && got.Repositories["web"].Path != web {
				t.Fatalf("web = %+v", got.Repositories["web"])
			}
			if !strings.Contains(terminal.String(), "a folder of repositories") {
				t.Fatalf("terminal = %s", terminal.String())
			}
			if (mode == "not git" || mode == "name clash") && strings.Count(terminal.String(), "Repositories:") != 2 {
				t.Fatalf("did not ask again: %s", terminal.String())
			}
		})
	}
}

func TestInitRepeatedRepositorySelection(t *testing.T) {
	for _, mode := range []string{"same path", "skip keeps existing", "same origin", "different origin", "different path"} {
		t.Run(mode, func(t *testing.T) {
			machine, _, fleet := aMain(t)
			root := t.TempDir()
			web := aGitRepository(t, filepath.Join(root, "web"))
			other := aGitRepository(t, filepath.Join(root, "other", "web"))
			initial := append(setupWords(), "--repositories", web)
			if strings.Contains(mode, "origin") {
				initial = append(setupWords(), "--repositories", "file://"+web)
			}
			if output, code := Main(initial, machine); code != 0 {
				t.Fatalf("first init = %d, %s", code, output)
			}
			next := initial
			switch mode {
			case "skip keeps existing":
				next = append(setupWords(), "--no-repositories")
			case "different path":
				next = append(setupWords(), "--repositories", other)
			case "different origin":
				next = append(setupWords(), "--repositories", "file://"+other)
			}
			output, code := Main(next, machine)
			if strings.HasPrefix(mode, "different") {
				if code != 1 || !strings.Contains(output, "web") {
					t.Fatalf("second init = %d, %s", code, output)
				}
			} else if code != 0 {
				t.Fatalf("second init = %d, %s", code, output)
			}
			if len(fleet.registered) != 1 {
				t.Fatalf("registered = %v", fleet.registered)
			}
			got, err := config.Load(pathsOf(machine).Config)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Repositories) != 1 {
				t.Fatalf("repositories = %+v", got.Repositories)
			}
		})
	}
}

func TestInitNamesEveryMissingFlagAfterHarnessesAreGiven(t *testing.T) {
	m := newMachine(t)
	_, err := m.init.Run(Flags{Harnesses: []string{"claude-code"}})
	for _, flag := range []string{"--fleet-url", "--ship-id", "--secret", "--repositories", "--repositories-in", "--no-repositories"} {
		if err == nil || !strings.Contains(err.Error(), flag) {
			t.Errorf("error = %v, want missing %s", err, flag)
		}
	}
	if len(m.fleet.registered) != 0 {
		t.Fatal("registered without complete options")
	}
}

type interruptedRepositoryTerminal struct {
	scriptedTerminal
	err error
}

func (s *interruptedRepositoryTerminal) Read(p []byte) (int, error) {
	if s.err != nil {
		err := s.err
		s.err = nil
		return 0, err
	}
	return s.scriptedTerminal.Read(p)
}

func TestInitRepositoryWizardStopsWhenTheTerminalCannotBeRead(t *testing.T) {
	machine, _, fleet := aMain(t)
	interrupted := errors.New("terminal disconnected")
	terminal := &interruptedRepositoryTerminal{scriptedTerminal: scriptedTerminal{input: strings.NewReader("3\n")}, err: interrupted}
	machine.OpenTerminal = func() (io.ReadWriteCloser, error) { return terminal, nil }
	words := setupWords()
	words = append(words[:len(words)-1], "--unattended=")
	output, code := Main(words, machine)
	if code != 1 || !strings.Contains(output, interrupted.Error()) {
		t.Fatalf("init = %d, %s, want terminal error", code, output)
	}
	if len(fleet.registered) != 0 {
		t.Fatal("registered after a terminal read failure")
	}
}
