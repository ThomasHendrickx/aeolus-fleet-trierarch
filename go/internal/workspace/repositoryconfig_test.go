package workspace

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
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

// aThrowawayHome is a HOME whose git config is the machine's own, for the test alone: answers its config file.
func aThrowawayHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	config := filepath.Join(home, ".gitconfig")
	t.Setenv("HOME", home)
	t.Setenv("GIT_CONFIG_GLOBAL", config)
	return config
}

// hasLFS says whether git-lfs is on the machine: its test runs only where it is.
func hasLFS() bool {
	return exec.Command("git", "lfs", "version").Run() == nil
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
		{"a filter driver in the machine's own config", func(t *testing.T, folder string, program string) {
			machine := aThrowawayHome(t)
			gitIn(t, "config", "--file", machine, "filter.planted.clean", program)
			gitIn(t, "config", "--file", machine, "filter.planted.smudge", program)
			gitIn(t, "config", "--file", machine, "filter.planted.required", "true")
			writeIn(t, folder, ".gitattributes", "* filter=planted\n")
		}},
	}
	if hasLFS() {
		plants = append(plants, struct {
			name  string
			plant func(t *testing.T, folder string, program string)
		}{"git-lfs's filter, as git lfs install writes it, with an extension in the machine's own config", func(t *testing.T, folder string, program string) {
			machine := aThrowawayHome(t)
			gitIn(t, "lfs", "install", "--skip-repo")
			gitIn(t, "config", "--file", machine, "lfs.extension.planted.clean", program+" %f")
			gitIn(t, "config", "--file", machine, "lfs.extension.planted.smudge", program+" %f")
			gitIn(t, "config", "--file", machine, "lfs.extension.planted.priority", "0")
			writeIn(t, folder, ".gitattributes", "*.md filter=lfs diff=lfs merge=lfs\n")
		}})
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

// anotherRepository is another repository on the host, with a change of its own, where a clone's git is pointed.
func anotherRepository(t *testing.T) string {
	t.Helper()
	other := filepath.Join(t.TempDir(), "other")
	gitIn(t, "init", "-q", "-b", "main", other)
	commitIn(t, other, "OTHER.md")
	writeIn(t, other, "OTHER.md", "CHANGED\n")
	return other
}

// A clone the host does not read is unsaved, as what it holds is not known.
func TestTheHostReadsAClonesOnlyThroughItsOwnGitFolder(t *testing.T) {
	pointings := []struct {
		name   string
		reason string
		point  func(t *testing.T, clone string, other string)
	}{
		{"core.worktree in its config", "its config sets core.worktree, which points git at another folder", func(t *testing.T, clone string, other string) {
			gitIn(t, "-C", clone, "config", "core.worktree", other)
		}},
		{"a .git file naming another git folder", "its .git is no folder of its own", func(t *testing.T, clone string, other string) {
			if err := os.Rename(filepath.Join(clone, ".git"), filepath.Join(t.TempDir(), "moved.git")); err != nil {
				t.Fatal(err)
			}
			writeIn(t, clone, ".git", "gitdir: "+filepath.Join(other, ".git")+"\n")
		}},
		{"a .git link to another git folder", "its .git is no folder of its own", func(t *testing.T, clone string, other string) {
			if err := os.Rename(filepath.Join(clone, ".git"), filepath.Join(t.TempDir(), "moved.git")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(other, ".git"), filepath.Join(clone, ".git")); err != nil {
				t.Fatal(err)
			}
		}},
		{"a commondir in its .git naming another git folder", "its .git names another git folder in its commondir", func(t *testing.T, clone string, other string) {
			writeIn(t, filepath.Join(clone, ".git"), "commondir", filepath.Join(other, ".git")+"\n")
		}},
		{"an alternates file naming another repository's objects", "its .git names another repository's objects in objects/info/alternates", func(t *testing.T, clone string, other string) {
			writeIn(t, filepath.Join(clone, ".git", "objects", "info"), "alternates", filepath.Join(other, ".git", "objects")+"\n")
		}},
	}
	for _, name := range []string{"lfs.extension.planted.clean", "lfs.customtransfer.planted.path"} {
		pointings = append(pointings, struct {
			name   string
			reason string
			point  func(t *testing.T, clone string, other string)
		}{name + " in its config", "its config names a program for git-lfs: " + name, func(t *testing.T, clone string, other string) {
			gitIn(t, "-C", clone, "config", name, filepath.Join(other, "program"))
		}})
	}
	for _, name := range []string{"extensions.partialclone", "remote.other.promisor"} {
		pointings = append(pointings, struct {
			name   string
			reason string
			point  func(t *testing.T, clone string, other string)
		}{name + " in its config, at a commit only another repository has", "its config names a remote to fetch missing objects from: " + name, func(t *testing.T, clone string, other string) {
			gitIn(t, "-C", clone, "config", "core.repositoryformatversion", "1")
			if name == "extensions.partialclone" {
				gitIn(t, "-C", clone, "config", "extensions.partialClone", "other")
			}
			gitIn(t, "-C", clone, "config", "remote.other.url", other)
			gitIn(t, "-C", clone, "config", "remote.other.promisor", "true")
			writeIn(t, filepath.Join(clone, ".git"), "HEAD", gitIn(t, "-C", other, "rev-parse", "HEAD"))
		}})
	}
	for _, inGit := range []string{"objects", "config", "HEAD", filepath.Join("refs", "heads")} {
		pointings = append(pointings, struct {
			name   string
			reason string
			point  func(t *testing.T, clone string, other string)
		}{"a link as its .git's " + inGit, "its .git holds a link: " + inGit, func(t *testing.T, clone string, other string) {
			if err := os.RemoveAll(filepath.Join(clone, ".git", inGit)); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(other, ".git", inGit), filepath.Join(clone, ".git", inGit)); err != nil {
				t.Fatal(err)
			}
		}})
	}
	for _, pointing := range pointings {
		t.Run(pointing.name, func(t *testing.T) {
			repository, root := aRepository(t)
			places := clonePlaces(repository, root, t.TempDir())
			folder := prepared(t, places, scoutInAeolusFleet, "scout")
			pointing.point(t, folder, anotherRepository(t))

			unsaved, err := places.Unsaved(folder)

			if want := []string{"refused, " + pointing.reason}; err != nil || !slices.Equal(unsaved, want) {
				t.Errorf("Unsaved(%s) with %s = %q, %v, want %q", folder, pointing.name, unsaved, err, want)
			}
		})
	}
}

// A git without hooks in its config runs none either way.
func TestTheHostsGitCallsInAShipsFolderRunNoHookTheFoldersConfigNames(t *testing.T) {
	repository, _ := aRepository(t)
	program, marker := aMarkingScript(t, filepath.Join(t.TempDir(), "hook"))
	gitIn(t, "-C", repository, "config", "hook.planted.command", program)
	for _, event := range []string{"reference-transaction", "post-checkout", "post-index-change"} {
		gitIn(t, "-C", repository, "config", "--add", "hook.planted.event", event)
	}

	for _, args := range [][]string{{"checkout", "--quiet", "--detach", "HEAD"}, {"status", "--porcelain"}} {
		if _, err := gitInFolder(repository, args...); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}

	if _, err := os.Stat(marker); err == nil {
		t.Errorf("with a hook planted in the folder's config, the host's git calls ran it")
	}
}

func TestTheHostsGitCallsInAShipsFolderFetchNoObjectTheFolderLacks(t *testing.T) {
	repository, _ := aRepository(t)
	other := filepath.Join(t.TempDir(), "other")
	gitIn(t, "init", "-q", "-b", "main", other)
	commitIn(t, other, "OTHER.md")
	gitIn(t, "-C", repository, "config", "remote.other.url", other)
	gitIn(t, "-C", repository, "config", "remote.other.promisor", "true")
	missing := strings.TrimSpace(gitIn(t, "-C", other, "rev-parse", "HEAD"))

	out, err := gitInFolder(repository, "log", "--format=%s", missing)

	if err == nil {
		t.Errorf("gitInFolder(log %s) = %q, want a failure, the commit missing", missing, out)
	}
}
