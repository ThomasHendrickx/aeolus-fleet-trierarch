package cli

import (
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
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
