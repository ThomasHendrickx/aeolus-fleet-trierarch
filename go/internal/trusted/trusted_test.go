package trusted

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

func listOf(t *testing.T, entries ...map[string]any) string {
	t.Helper()
	text, err := json.Marshal(map[string]any{"repositories": entries})
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func entry(name any, url any) map[string]any { return map[string]any{"name": name, "url": url} }

func TestReadTakesEachNameWithItsGitURL(t *testing.T) {
	payload := listOf(t,
		entry("aeolus-fleet", "https://github.com/ThomasHendrickx/aeolus-fleet.git"),
		entry("hemma", "git@github.com:ThomasHendrickx/hemma.git"),
		entry("skills", "ssh://git@github.com/ThomasHendrickx/skills.git"),
	)

	got, err := Read(payload)

	want := []Repository{
		{Name: "aeolus-fleet", URL: "https://github.com/ThomasHendrickx/aeolus-fleet.git"},
		{Name: "hemma", URL: "git@github.com:ThomasHendrickx/hemma.git"},
		{Name: "skills", URL: "ssh://git@github.com/ThomasHendrickx/skills.git"},
	}
	if err != nil || len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Errorf("Read(list) = %v, %v, want %v", got, err, want)
	}
}

func TestReadTakesNoneFromAnEmptyList(t *testing.T) {
	got, err := Read(`{"repositories":[]}`)

	if err != nil || got == nil || len(got) != 0 {
		t.Errorf("Read(empty list) = %#v, %v, want an empty list and no error", got, err)
	}
}

func TestReadRefuses(t *testing.T) {
	for _, test := range []struct{ label, payload string }{
		{"a payload that is no JSON", "hemma=git@github.com:a/b.git"},
		{"a payload without repositories", "{}"},
		{"repositories that are null", `{"repositories":null}`},
		{"a payload that is a list", "[]"},
		{"an entry that is null", `{"repositories":[null]}`},
		{"a name that is a path", listOf(t, entry("a/b", "https://github.com/a/b.git"))},
		{"a name that starts with a dot", listOf(t, entry(".hidden", "https://github.com/a/b.git"))},
		{"a name of 101 characters", listOf(t, entry(strings.Repeat("a", 101), "https://github.com/a/b.git"))},
		{"a name that is no text", listOf(t, entry(1, "https://github.com/a/b.git"))},
		{"a name given twice", listOf(t, entry("hemma", "https://github.com/a/b.git"), entry("hemma", "https://github.com/a/c.git"))},
		{"a URL that is no text", listOf(t, entry("hemma", 1))},
		{"a plain http URL", listOf(t, entry("hemma", "http://github.com/a/b.git"))},
		{"a file URL", listOf(t, entry("hemma", "file:///srv/git/hemma.git"))},
		{"a local path", listOf(t, entry("hemma", "/srv/git/hemma.git"))},
		{"a remote helper that runs a command", listOf(t, entry("hemma", "ext::sh -c touch% /tmp/x"))},
		{"an https URL with a user and password", listOf(t, entry("hemma", "https://me:secret@github.com/a/b.git"))},
		{"an https URL with a token as its user", listOf(t, entry("hemma", "https://ghp_token@github.com/a/b.git"))},
		{"an https URL with no repository", listOf(t, entry("hemma", "https://github.com"))},
		{"an ssh URL with a password", listOf(t, entry("hemma", "ssh://git:secret@github.com/a/b.git"))},
		{"an ssh URL whose user reads as an option", listOf(t, entry("hemma", "ssh://-oProxyCommand=touch%20x@github.com/a/b.git"))},
		{"an ssh URL whose host reads as an option", listOf(t, entry("hemma", "ssh://git@-oProxyCommand=x/a/b.git"))},
		{"an scp-like URL whose user reads as an option", listOf(t, entry("hemma", "-oProxyCommand=x@github.com:a/b.git"))},
		{"an scp-like URL whose host reads as an option", listOf(t, entry("hemma", "git@-oProxyCommand=x:a/b.git"))},
		{"a URL that reads as an option", listOf(t, entry("hemma", "--upload-pack=touch x"))},
		{"a URL with a space", listOf(t, entry("hemma", "git@github.com:a/b c.git"))},
		{"an ssh URL whose user does not decode", listOf(t, entry("hemma", "ssh://%zz@github.com/a/b.git"))},
	} {
		t.Run(test.label, func(t *testing.T) {
			if got, err := Read(test.payload); err == nil {
				t.Errorf("Read(%s) = %v, want a refusal", test.payload, got)
			}
		})
	}
}

func TestReadTakesAHundredCharacterName(t *testing.T) {
	name := strings.Repeat("a", 100)

	got, err := Read(listOf(t, entry(name, "https://github.com/a/b.git")))

	if err != nil || len(got) != 1 || got[0].Name != name {
		t.Errorf("Read(100 character name) = %v, %v, want it taken", got, err)
	}
}

func TestReadNamesTheRepositoryWhoseURLItRefuses(t *testing.T) {
	_, err := Read(listOf(t, entry("hemma", "file:///srv/git/hemma.git")))

	want := "hemma: a trusted repository is an https:// or ssh URL, never a path, a file URL or a credential"
	if err == nil || err.Error() != want {
		t.Errorf("Read(file URL) error = %v, want %q", err, want)
	}
}

func TestWithRepositoriesOffersEachTrustedRepositoryAtItsCloneBesideTheConfiguredOnes(t *testing.T) {
	configured := config.Configuration{Repositories: map[string]config.Repository{"aeolus-fleet": {Path: "/home/me/aeolus-fleet", Checkouts: []string{"skills"}}}}
	cloneOf := func(name string) string { return "/clones/" + name }

	got := WithRepositories(configured, []Repository{{Name: "hemma", URL: "git@github.com:a/hemma.git"}}, cloneOf)

	if len(got.Repositories) != 2 || got.Repositories["hemma"].Path != "/clones/hemma" || got.Repositories["aeolus-fleet"].Path != "/home/me/aeolus-fleet" {
		t.Errorf("repositories = %v, want the configured one and hemma at its clone", got.Repositories)
	}
	if len(configured.Repositories) != 1 {
		t.Errorf("the configuration given gained a repository: %v", configured.Repositories)
	}
}

func TestWithRepositoriesKeepsAConfiguredRepositoryOfTheSameNameAsConfigured(t *testing.T) {
	configured := config.Configuration{Repositories: map[string]config.Repository{"aeolus-fleet": {Path: "/home/me/aeolus-fleet", Checkouts: []string{"skills"}}}}

	got := WithRepositories(configured, []Repository{{Name: "aeolus-fleet", URL: "https://github.com/a/b.git"}}, func(name string) string { return "/clones/" + name })

	if repository := got.Repositories["aeolus-fleet"]; repository.Path != "/home/me/aeolus-fleet" || len(repository.Checkouts) != 1 {
		t.Errorf("aeolus-fleet = %v, want it as configured", repository)
	}
}

func aFile(t *testing.T, trust func([]string) error) *File {
	t.Helper()
	root := t.TempDir()
	return &File{Path: filepath.Join(root, "trusted-repositories.json"), ClonesRoot: filepath.Join(root, "repositories"), TrustClones: trust}
}

func noTrust([]string) error { return nil }

func TestFileHoldsNoneWhenMissing(t *testing.T) {
	file := aFile(t, noTrust)

	file.Load()

	if got := file.Current(); len(got) != 0 {
		t.Errorf("Current() = %v, want none", got)
	}
}

func TestFileHoldsNoneWhenItDoesNotFit(t *testing.T) {
	file := aFile(t, noTrust)
	if err := os.WriteFile(file.Path, []byte(`{"repositories":[{"name":"hemma","url":"/srv/git/hemma.git"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	file.Load()

	if got := file.Current(); len(got) != 0 {
		t.Errorf("Current() = %v, want none: a list written by hand trusts nothing", got)
	}
}

func TestFileKeepsTheAcceptedListAcrossLoads(t *testing.T) {
	file := aFile(t, noTrust)
	list := []Repository{{Name: "hemma", URL: "git@github.com:a/hemma.git"}}

	if err := file.Accept(list); err != nil {
		t.Fatal(err)
	}
	again := &File{Path: file.Path, ClonesRoot: file.ClonesRoot, TrustClones: noTrust}
	again.Load()

	if got := again.Current(); len(got) != 1 || got[0] != list[0] {
		t.Errorf("Current() after Load = %v, want %v", got, list)
	}
	text, _ := os.ReadFile(file.Path)
	if want := "{\n  \"repositories\": [\n    {\n      \"name\": \"hemma\",\n      \"url\": \"git@github.com:a/hemma.git\"\n    }\n  ]\n}\n"; string(text) != want {
		t.Errorf("file = %q, want %q", text, want)
	}
}

func TestFileTrustsEachClonesPathBeforeItKeepsTheList(t *testing.T) {
	var trusted []string
	var file *File
	file = aFile(t, func(paths []string) error {
		trusted = paths
		if _, err := os.Stat(file.Path); err == nil {
			t.Error("the list was kept before the clones were trusted")
		}
		return nil
	})

	if err := file.Accept([]Repository{{Name: "hemma", URL: "git@github.com:a/hemma.git"}, {Name: "skills", URL: "git@github.com:a/skills.git"}}); err != nil {
		t.Fatal(err)
	}

	if len(trusted) != 2 || trusted[0] != filepath.Join(file.ClonesRoot, "hemma") || trusted[1] != filepath.Join(file.ClonesRoot, "skills") {
		t.Errorf("trusted = %v, want the path of each clone", trusted)
	}
}

func TestFileKeepsTheListItHoldsWhenTheClonesCannotBeTrusted(t *testing.T) {
	held := []Repository{{Name: "hemma", URL: "git@github.com:a/hemma.git"}}
	file := aFile(t, noTrust)
	if err := file.Accept(held); err != nil {
		t.Fatal(err)
	}
	file.TrustClones = func([]string) error { return os.ErrPermission }

	err := file.Accept([]Repository{{Name: "skills", URL: "git@github.com:a/skills.git"}})

	if err == nil {
		t.Fatal("Accept = nil, want the failure")
	}
	if got := file.Current(); len(got) != 1 || got[0] != held[0] {
		t.Errorf("Current() = %v, want the held list %v", got, held)
	}
}

// aSourceRepository is a repository with one commit, as a folder git clones from.
func aSourceRepository(t *testing.T) string {
	t.Helper()
	work := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		command := exec.Command("git", args...)
		command.Env = append(os.Environ(), "GIT_AUTHOR_NAME=T", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=T", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main", work)
	if err := os.WriteFile(filepath.Join(work, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("-C", work, "add", ".")
	run("-C", work, "commit", "-q", "-m", "init")
	return work
}

func TestClonesRefuseAFolderAsTheRemote(t *testing.T) {
	source := aSourceRepository(t)
	path := filepath.Join(t.TempDir(), "hemma")
	clones := Clones{Root: filepath.Dir(path), URLOf: func(string) string { return source }}

	err := clones.WhenMissing("hemma", path)

	if err == nil || !strings.HasPrefix(err.Error(), "git clone of hemma failed: ") {
		t.Errorf("WhenMissing from a folder = %v, want git's refusal of the protocol", err)
	}
	if _, err := os.Stat(path); err == nil {
		t.Errorf("%s exists after a refused clone", path)
	}
	if _, err := os.Stat(path + ".partial"); err == nil {
		t.Errorf("%s.partial is left after a refused clone", path)
	}
}

func TestClonesCloneOverSshWithTheMachinesOwnAccess(t *testing.T) {
	source := aSourceRepository(t)
	bin := t.TempDir()
	// git's ssh transport runs the remote command here, as ssh to this computer would.
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte("#!/bin/sh\nfor command; do :; done\nexec sh -c \"$command\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "repositories", "hemma")
	clones := Clones{Root: filepath.Dir(path), URLOf: func(string) string { return "ssh://git@origin.example.test" + source }, Environ: append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"))}

	if err := clones.WhenMissing("hemma", path); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(path, "README.md")); err != nil {
		t.Errorf("the clone lacks the repository's file: %v", err)
	}
	if _, err := os.Stat(path + ".partial"); err == nil {
		t.Errorf("%s.partial is left after a clone", path)
	}
}

func TestClonesCloneNothingWhenTheMachineHasTheRepository(t *testing.T) {
	path := t.TempDir()
	clones := Clones{Root: filepath.Dir(path), URLOf: func(string) string { return "ssh://git@origin.example.test/nowhere.git" }}

	if err := clones.WhenMissing("hemma", path); err != nil {
		t.Errorf("WhenMissing with the clone present = %v, want none", err)
	}
}

func TestClonesCloneNothingForARepositoryNotOnTheList(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hemma")
	clones := Clones{Root: filepath.Dir(path), URLOf: func(string) string { return "" }}

	if err := clones.WhenMissing("hemma", path); err != nil {
		t.Errorf("WhenMissing off the list = %v, want none", err)
	}
	if _, err := os.Stat(path); err == nil {
		t.Errorf("%s exists though nothing was cloned", path)
	}
}

func TestClonesEndAClonePastItsTimeoutAndLeaveNoHalfClone(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "hemma")
	clones := Clones{Root: filepath.Dir(path), URLOf: func(string) string { return "ssh://git@origin.example.test/a.git" }, Environ: append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH")), Timeout: 300 * time.Millisecond}

	err := clones.WhenMissing("hemma", path)

	if err == nil || err.Error() != "git clone of hemma failed: timed out" {
		t.Errorf("WhenMissing past its timeout = %v, want it timed out", err)
	}
	if _, err := os.Stat(path + ".partial"); err == nil {
		t.Errorf("%s.partial is left after a timeout", path)
	}
}

func TestClonedPathIsTheCloneOfARepositoryOnlyWhileItExists(t *testing.T) {
	root := t.TempDir()
	clones := Clones{Root: root}
	if _, ok := clones.ClonedPath("hemma"); ok {
		t.Error("ClonedPath(hemma) found a clone that does not exist")
	}
	if err := os.MkdirAll(filepath.Join(root, "hemma"), 0o755); err != nil {
		t.Fatal(err)
	}

	path, ok := clones.ClonedPath("hemma")

	if !ok || path != filepath.Join(root, "hemma") {
		t.Errorf("ClonedPath(hemma) = %q, %v, want its folder", path, ok)
	}
}

type fakeFleet struct {
	asked  []string
	refuse error
}

func (f *fakeFleet) AskForTrustedRepositories(pluginShipID string) error {
	f.asked = append(f.asked, pluginShipID)
	return f.refuse
}

func TestAskAsksTheTrierarchPluginsShipOnceAndNoMore(t *testing.T) {
	fleet := &fakeFleet{}
	ask := &Ask{Fleet: fleet, PluginShipID: "shp_plugin", Log: func(string) {}}

	ask.Once()
	ask.Once()

	if len(fleet.asked) != 1 || fleet.asked[0] != "shp_plugin" {
		t.Errorf("asked = %v, want the plugin's ship once", fleet.asked)
	}
}

func TestAskAsksAgainOnTheNextPassWhenTheFleetDoesNotTakeIt(t *testing.T) {
	fleet := &fakeFleet{refuse: os.ErrDeadlineExceeded}
	var logged []string
	ask := &Ask{Fleet: fleet, PluginShipID: "shp_plugin", Log: func(line string) { logged = append(logged, line) }}

	ask.Once()
	fleet.refuse = nil
	ask.Once()
	ask.Once()

	if len(fleet.asked) != 2 {
		t.Errorf("asked %d times, want 2: once refused, once taken, then no more", len(fleet.asked))
	}
	want := "Could not ask the trierarch plugin's ship for the trusted repositories: i/o timeout; the next pass asks again"
	if len(logged) != 1 || logged[0] != want {
		t.Errorf("logged = %q, want %q", logged, want)
	}
}

func TestAskAsksNothingWhenTheMachineDoesNotKnowTheShip(t *testing.T) {
	fleet := &fakeFleet{}
	ask := &Ask{Fleet: fleet, Log: func(string) {}}

	ask.Once()

	if len(fleet.asked) != 0 {
		t.Errorf("asked = %v, want nothing", fleet.asked)
	}
}
