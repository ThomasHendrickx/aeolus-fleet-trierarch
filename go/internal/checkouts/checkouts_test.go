package checkouts

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

func gitIn(t *testing.T, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=t@example.com")
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func commit(t *testing.T, repository string, file string) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repository, file), []byte(file+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, "-C", repository, "add", ".")
	gitIn(t, "-C", repository, "commit", "-q", "-m", file)
	return gitIn(t, "-C", repository, "rev-parse", "HEAD")
}

func aRepository(t *testing.T, folder string, name string) string {
	t.Helper()
	repository := filepath.Join(folder, name)
	gitIn(t, "init", "-q", "-b", "main", repository)
	commit(t, repository, "README.md")
	return repository
}

// machine is the company repository naming governance and skills as its checkouts, governance with a remote whose main moves on.
type machine struct {
	root       string
	governance string
	skills     string
	upstream   string
	checkouts  Git
}

func aMachine(t *testing.T) machine {
	t.Helper()
	folder := t.TempDir()
	t.Cleanup(func() { _ = exec.Command("chmod", "-R", "u+w", folder).Run() })
	company := aRepository(t, folder, "aeolus-company")
	governance := aRepository(t, folder, "governance")
	skills := aRepository(t, folder, "skills")
	upstream := filepath.Join(folder, "governance-upstream")
	gitIn(t, "clone", "-q", governance, upstream)
	gitIn(t, "-C", governance, "remote", "add", "origin", upstream)
	gitIn(t, "-C", governance, "fetch", "-q", "origin")
	root := filepath.Join(folder, "checkouts")
	return machine{root: root, governance: governance, skills: skills, upstream: upstream, checkouts: Git{Root: root, Repositories: map[string]config.Repository{
		"aeolus-company": {Path: company, Checkouts: []string{"governance", "skills"}},
		"governance":     {Path: governance},
		"skills":         {Path: skills},
	}}}
}

func headOf(t *testing.T, path string) string {
	t.Helper()
	return gitIn(t, "-C", path, "rev-parse", "HEAD")
}

func TestACheckoutIsMadeOfEachRepositoryTheWorkingRepositoryNamesPerShip(t *testing.T) {
	m := aMachine(t)

	made, err := m.checkouts.Prepare("shp_scout", "aeolus-company")

	if err != nil {
		t.Fatal(err)
	}
	want := []Checkout{{Repository: "governance", Path: filepath.Join(m.root, "shp_scout", "governance")}, {Repository: "skills", Path: filepath.Join(m.root, "shp_scout", "skills")}}
	if len(made) != 2 || made[0] != want[0] || made[1] != want[1] {
		t.Fatalf("made %v, want %v", made, want)
	}
	if _, err := os.Stat(filepath.Join(m.root, "shp_scout", "skills", "README.md")); err != nil {
		t.Fatal(err)
	}
}

func TestARepositoryThatNamesNoneMakesNone(t *testing.T) {
	m := aMachine(t)

	made, err := m.checkouts.Prepare("shp_scout", "skills")

	if err != nil || len(made) != 0 {
		t.Fatalf("made %v, %v", made, err)
	}
}

func TestACheckoutIsDetachedAtTheLatestMainOfTheRemoteFetchedFirst(t *testing.T) {
	m := aMachine(t)
	latest := commit(t, m.upstream, "rule.md")

	if _, err := m.checkouts.Prepare("shp_scout", "aeolus-company"); err != nil {
		t.Fatal(err)
	}

	if got := headOf(t, filepath.Join(m.root, "shp_scout", "governance")); got != latest {
		t.Fatalf("head %s, want %s", got, latest)
	}
}

func TestACheckoutIsOfTheRepositorysOwnMainWhenItHasNoRemote(t *testing.T) {
	m := aMachine(t)
	latest := commit(t, m.skills, "skill.md")

	if _, err := m.checkouts.Prepare("shp_scout", "aeolus-company"); err != nil {
		t.Fatal(err)
	}

	if got := headOf(t, filepath.Join(m.root, "shp_scout", "skills")); got != latest {
		t.Fatalf("head %s, want %s", got, latest)
	}
}

func TestACheckoutTheShipHasAlreadyStaysAsItIs(t *testing.T) {
	m := aMachine(t)
	_, _ = m.checkouts.Prepare("shp_scout", "aeolus-company")
	before := headOf(t, filepath.Join(m.root, "shp_scout", "governance"))
	commit(t, m.upstream, "rule.md")

	if _, err := m.checkouts.Prepare("shp_scout", "aeolus-company"); err != nil {
		t.Fatal(err)
	}

	if got := headOf(t, filepath.Join(m.root, "shp_scout", "governance")); got != before {
		t.Fatalf("head %s moved from %s", got, before)
	}
}

func TestTheSessionChangesNoFileInACheckout(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root writes through a missing write bit")
	}
	m := aMachine(t)
	_, _ = m.checkouts.Prepare("shp_scout", "aeolus-company")
	checkout := filepath.Join(m.root, "shp_scout", "governance")

	changed := os.WriteFile(filepath.Join(checkout, "README.md"), []byte("changed\n"), 0o644)
	added := os.WriteFile(filepath.Join(checkout, "new.md"), []byte("new\n"), 0o644)

	if !errors.Is(changed, os.ErrPermission) || !errors.Is(added, os.ErrPermission) {
		t.Fatalf("changed %v, added %v", changed, added)
	}
}

func TestTheSessionCommitsNothingInACheckout(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root writes through a missing write bit")
	}
	m := aMachine(t)
	_, _ = m.checkouts.Prepare("shp_scout", "aeolus-company")
	command := exec.Command("git", "-C", filepath.Join(m.root, "shp_scout", "governance"), "commit", "-q", "--allow-empty", "-m", "mine")
	command.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=t@example.com")

	if err := command.Run(); err == nil {
		t.Fatal("the commit succeeded")
	}
}

func TestACheckoutHasNoRemoteToPushTo(t *testing.T) {
	m := aMachine(t)
	_, _ = m.checkouts.Prepare("shp_scout", "aeolus-company")

	if remotes := gitIn(t, "-C", filepath.Join(m.root, "shp_scout", "governance"), "remote"); remotes != "" {
		t.Fatalf("remotes %q", remotes)
	}
}

func TestARefreshBringsEachCheckoutToTheLatestMainAndAnswersTheRevision(t *testing.T) {
	m := aMachine(t)
	_, _ = m.checkouts.Prepare("shp_scout", "aeolus-company")
	governance := commit(t, m.upstream, "rule.md")
	skills := commit(t, m.skills, "skill.md")

	refreshed := m.checkouts.Refresh("shp_scout")

	if len(refreshed) != 2 || refreshed[0] != (Refreshed{Repository: "governance", Revision: governance}) || refreshed[1] != (Refreshed{Repository: "skills", Revision: skills}) {
		t.Fatalf("refreshed %v", refreshed)
	}
	if _, err := os.Stat(filepath.Join(m.root, "shp_scout", "governance", "rule.md")); err != nil {
		t.Fatal(err)
	}
}

func TestARefreshedCheckoutIsReadOnlyAgain(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root writes through a missing write bit")
	}
	m := aMachine(t)
	_, _ = m.checkouts.Prepare("shp_scout", "aeolus-company")
	commit(t, m.upstream, "rule.md")
	m.checkouts.Refresh("shp_scout")

	err := os.WriteFile(filepath.Join(m.root, "shp_scout", "governance", "rule.md"), []byte("changed\n"), 0o644)

	if !errors.Is(err, os.ErrPermission) {
		t.Fatalf("write %v", err)
	}
}

func TestARefreshAnswersWhyACheckoutCouldNotBeRefreshedAndRefreshesTheOthers(t *testing.T) {
	m := aMachine(t)
	_, _ = m.checkouts.Prepare("shp_scout", "aeolus-company")
	if err := os.RemoveAll(m.governance); err != nil {
		t.Fatal(err)
	}
	skills := commit(t, m.skills, "skill.md")

	refreshed := m.checkouts.Refresh("shp_scout")

	if len(refreshed) != 2 || refreshed[0].Repository != "governance" || !strings.Contains(refreshed[0].Problem, "governance") || strings.Contains(refreshed[0].Problem, "\n") || refreshed[0].Revision != "" {
		t.Fatalf("first %v", refreshed)
	}
	if refreshed[1] != (Refreshed{Repository: "skills", Revision: skills}) {
		t.Fatalf("second %v", refreshed[1])
	}
}

func TestARefreshOfAShipWithNoCheckoutsAnswersNone(t *testing.T) {
	m := aMachine(t)

	if refreshed := m.checkouts.Refresh("shp_scout"); len(refreshed) != 0 {
		t.Fatalf("refreshed %v", refreshed)
	}
}

func TestRemovingTheShipsCheckoutsLeavesNoneOfItsOwnAndNoneOfAnotherShipsGone(t *testing.T) {
	m := aMachine(t)
	_, _ = m.checkouts.Prepare("shp_scout", "aeolus-company")
	_, _ = m.checkouts.Prepare("shp_lookout", "aeolus-company")

	if err := m.checkouts.Remove("shp_scout"); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(m.root, "shp_scout")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("scout's checkouts stay: %v", err)
	}
	if _, err := os.Stat(filepath.Join(m.root, "shp_lookout", "governance", "README.md")); err != nil {
		t.Fatal(err)
	}
}

func TestRemovingTheCheckoutsOfAShipWithNoneIsNothing(t *testing.T) {
	m := aMachine(t)

	if err := m.checkouts.Remove("shp_scout"); err != nil {
		t.Fatal(err)
	}
}
