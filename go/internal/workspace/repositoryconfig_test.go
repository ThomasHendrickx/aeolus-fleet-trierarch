package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// aMarkingScript is a program that leaves a marker file when anything runs it, and answers the marker's path.
func aMarkingScript(t *testing.T, at string) (string, string) {
	t.Helper()
	marker := filepath.Join(t.TempDir(), "ran")
	script := fmt.Sprintf("#!/bin/sh\ntouch %q\ncat >/dev/null 2>&1\nexit 0\n", marker)
	if err := os.WriteFile(at, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return at, marker
}

func writeIn(t *testing.T, folder string, file string, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(folder, file), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestTheHostsGitCallsInASessionsCloneIgnoreTheClonesOwnConfig(t *testing.T) {
	plants := []struct {
		name  string
		plant func(t *testing.T, folder string, program string)
	}{
		{"core.fsmonitor", func(t *testing.T, folder string, program string) {
			gitIn(t, "-C", folder, "config", "core.fsmonitor", program)
		}},
		{"core.hooksPath with a hook", func(t *testing.T, folder string, program string) {
			gitIn(t, "-C", folder, "config", "core.hooksPath", filepath.Dir(program))
		}},
		{"a filter driver", func(t *testing.T, folder string, program string) {
			gitIn(t, "-C", folder, "config", "filter.planted.clean", program)
			gitIn(t, "-C", folder, "config", "filter.planted.smudge", program)
			writeIn(t, folder, ".gitattributes", "* filter=planted\n")
		}},
		{"diff.external", func(t *testing.T, folder string, program string) {
			gitIn(t, "-C", folder, "config", "diff.external", program)
		}},
		{"core.sshCommand", func(t *testing.T, folder string, program string) {
			gitIn(t, "-C", folder, "config", "core.sshCommand", program)
			gitIn(t, "-C", folder, "remote", "set-url", "origin", "ssh://git@example.com/aeolus-fleet.git")
		}},
		{"a filter driver in a submodule's own config", func(t *testing.T, folder string, program string) {
			module := filepath.Join(folder, "module")
			gitIn(t, "init", "-q", "-b", "main", module)
			commitIn(t, module, "README.md")
			gitIn(t, "-C", folder, "add", "module")
			writeIn(t, folder, ".gitmodules", "[submodule \"module\"]\n\tpath = module\n\turl = ./module\n")
			gitIn(t, "-C", module, "config", "filter.planted.clean", program)
			writeIn(t, module, ".gitattributes", "* filter=planted\n")
			writeIn(t, module, "README.md", "README.MD\n")
		}},
	}
	for _, planted := range plants {
		t.Run(planted.name, func(t *testing.T) {
			repository, root := aRepository(t)
			withUpstream(t, repository)
			places := clonePlaces(repository, root, t.TempDir())
			entry := reconciler.Entry{Workspace: reconciler.Workspace{Kind: "worktree", Repository: "aeolus-fleet"}}
			folder := prepared(t, places, entry, "scout")
			// One script under every hook's name, so any hook git runs leaves the marker.
			hooks := t.TempDir()
			program, marker := aMarkingScript(t, filepath.Join(hooks, "post-index-change"))
			for _, hook := range []string{"pre-commit", "post-checkout", "reference-transaction", "fsmonitor-watchman"} {
				if err := os.Symlink(program, filepath.Join(hooks, hook)); err != nil {
					t.Fatal(err)
				}
			}
			planted.plant(t, folder, program)
			// The same size as before, so git must read the file through its filter to tell whether it changed.
			writeIn(t, folder, "README.md", "HELLO\n")
			entry.Folder = folder

			unsaved, err := places.Unsaved(folder)
			if _, prepareErr := places.Prepare(entry, "scout"); prepareErr != nil {
				t.Fatal(prepareErr)
			}

			if err != nil || len(unsaved) == 0 {
				t.Errorf("Unsaved = %q, %v, want the clone's changes", unsaved, err)
			}
			if _, statErr := os.Stat(marker); statErr == nil {
				t.Errorf("with %s planted in the clone's config, the host's git calls ran it", planted.name)
			}
		})
	}
}
