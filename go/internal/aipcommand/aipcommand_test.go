package aipcommand

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

// standInUv is uv on a stand-in machine: `python install` makes a Python in UV_PYTHON_INSTALL_DIR, `venv` a venv of it, and `pip install` writes the
// venv's bin/aip, which states the version the requirements pin. It keeps its words, the uv variables it was given and the requirements in
// STAND_IN_UV_LOG, counts every pip run there, and fails pip while a PIP_FAILS file is there.
const standInUv = `#!/bin/sh
log="$STAND_IN_UV_LOG"
echo "$*" >> "$log/words"
env | grep '^UV_' | sort > "$log/uv-variables"
case "$1 $2" in
  "python install")
    mkdir -p "$UV_PYTHON_INSTALL_DIR/cpython-$3/bin" && printf '#!/bin/sh\n' > "$UV_PYTHON_INSTALL_DIR/cpython-$3/bin/python3" && chmod +x "$UV_PYTHON_INSTALL_DIR/cpython-$3/bin/python3" ;;
  "venv --python")
    mkdir -p "$4/bin" && ln -s "$UV_PYTHON_INSTALL_DIR/cpython-$3/bin/python3" "$4/bin/python" ;;
  "pip install")
    echo run >> "$log/pip-runs"
    [ -e "$log/SLOW" ] && sleep 1
    if [ -e "$log/PIP_FAILS" ]; then echo "error: hash mismatch for typing-extensions" >&2; exit 1; fi
    shift 2
    venv=""
    while [ $# -gt 0 ]; do
      [ "$1" = --python ] && venv=$(dirname "$(dirname "$2")")
      [ "$1" = -r ] && cp "$2" "$log/requirements"
      shift
    done
    version=$(sed -n 's/^agent-instruction-protocol==\([^ ]*\).*/\1/p' "$log/requirements")
    sed -e "s/@VERSION@/$version/" -e "s|@LOG@|$log|" "$log/aip" > "$venv/bin/aip" && chmod +x "$venv/bin/aip" ;;
esac
`

// standInAip is the aip the stand-in uv installs: `--version` states the version the requirements pin, and `skill install --path DIR` writes
// DIR/aip-compile and DIR/aip-runtime, each with its SKILL.md, and $HOME/.aip/skills.json, as aip 0.7.0 does; it fails while a SKILLS_FAIL file
// is in the stand-in uv's log, which it is written with, as aip may be given none of the trierarch's variables.
const standInAip = `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") echo "aip @VERSION@ format 0.6a1" ;;
  "skill install --path")
    if [ -e "@LOG@/SKILLS_FAIL" ]; then echo "error: cannot write $4" >&2; exit 1; fi
    for skill in aip-compile aip-runtime; do
      mkdir -p "$4/$skill" && printf -- '---\nname: %s\n---\n' "$skill" > "$4/$skill/SKILL.md"
    done
    mkdir -p "$HOME/.aip" && echo '{"version":1}' > "$HOME/.aip/skills.json" ;;
  *) exit 2 ;;
esac
`

// TestMain lets this test binary be another trierarch process that installs aip into the folder AIPCOMMAND_INSTALLER names, as init or upgrade does beside the service: it says the state it ended with.
func TestMain(m *testing.M) {
	if path := os.Getenv("AIPCOMMAND_INSTALLER"); path != "" {
		folder := Folder{Path: path, Outcome: os.Getenv("AIPCOMMAND_OUTCOME"), Uv: &Uv{URL: os.Getenv("AIPCOMMAND_UV_URL"), SHA256: os.Getenv("AIPCOMMAND_UV_SHA256")}}
		state := folder.Ensure()
		if err := json.NewEncoder(os.Stdout).Encode(state); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// aUvRelease serves uv's archive for this machine as the uv release does, and is the build that names it with its sha256.
func aUvRelease(t *testing.T) *Uv {
	t.Helper()
	var archive bytes.Buffer
	zipped := gzip.NewWriter(&archive)
	files := tar.NewWriter(zipped)
	for name, text := range map[string]string{"uv-stand-in/uv": standInUv, "uv-stand-in/uvx": "#!/bin/sh\n"} {
		if err := files.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(text)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := files.Write([]byte(text)); err != nil {
			t.Fatal(err)
		}
	}
	if err := files.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	served := archive.Bytes()
	release := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(served) }))
	t.Cleanup(release.Close)
	sum := sha256.Sum256(served)
	return &Uv{URL: release.URL + "/uv-stand-in.tar.gz", SHA256: hex.EncodeToString(sum[:])}
}

// aFolder is the aip folder in a throwaway home, with uv from a stand-in release, and the folder its stand-in uv logs in.
func aFolder(t *testing.T) (Folder, string) {
	t.Helper()
	log := t.TempDir()
	t.Setenv("STAND_IN_UV_LOG", log)
	if err := os.WriteFile(filepath.Join(log, "aip"), []byte(standInAip), 0o644); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	return Folder{Path: filepath.Join(home, "aip-command"), Outcome: filepath.Join(home, "aip-command.json"), Uv: aUvRelease(t)}, log
}

func aipVersionIn(t *testing.T, bin string) string {
	t.Helper()
	said, err := exec.Command(filepath.Join(bin, "aip"), "--version").Output()
	if err != nil {
		t.Fatalf("%s/aip --version: %v", bin, err)
	}
	return strings.TrimSpace(string(said))
}

func pipRuns(log string) int {
	text, _ := os.ReadFile(filepath.Join(log, "pip-runs"))
	return strings.Count(string(text), "run")
}

func readText(t *testing.T, path string) string {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func TestThePinnedAipIsInstalledIntoTheFolderAndItsBinRunsIt(t *testing.T) {
	folder, _ := aFolder(t)

	state := folder.Ensure()

	bin, ok := folder.Bin()
	if state != (State{Version: "0.7.0"}) || !ok || bin != filepath.Join(folder.Path, "venv", "bin") {
		t.Fatalf("Ensure() = %+v, Bin() = %q, %v; want 0.7.0 in %s/venv/bin", state, bin, ok, folder.Path)
	}
	if got := aipVersionIn(t, bin); got != "aip 0.7.0 format 0.6a1" {
		t.Errorf("aip --version = %q, want aip 0.7.0", got)
	}
}

func TestUvInstallsThePinnedPythonAndOnlyTheLockedRequirementsEachByItsHashAllInTheFolder(t *testing.T) {
	folder, log := aFolder(t)
	t.Setenv("UV_INDEX_URL", "https://index.example.invalid/simple")

	folder.Ensure()

	words := strings.Split(strings.TrimSpace(readText(t, filepath.Join(log, "words"))), "\n")
	want := []string{
		"python install 3.14.10 --no-bin",
		"venv --python 3.14.10 " + filepath.Join(folder.Path, "venv"),
		"pip install --python " + filepath.Join(folder.Path, "venv", "bin", "python") + " --require-hashes --no-deps --only-binary :all: -r " + filepath.Join(folder.Path, "requirements.txt"),
	}
	if strings.Join(words, "\n") != strings.Join(want, "\n") {
		t.Errorf("uv ran\n%s\nwant\n%s", strings.Join(words, "\n"), strings.Join(want, "\n"))
	}
	variables := readText(t, filepath.Join(log, "uv-variables"))
	for _, each := range []string{"UV_NO_CONFIG=1", "UV_PYTHON_PREFERENCE=only-managed", "UV_PYTHON_INSTALL_DIR=" + filepath.Join(folder.Path, "python"), "UV_CACHE_DIR=" + filepath.Join(folder.Path, "cache")} {
		if !strings.Contains(variables, each+"\n") {
			t.Errorf("uv was given\n%s\nwant %s among them", variables, each)
		}
	}
	if strings.Contains(variables, "UV_INDEX_URL") {
		t.Errorf("uv was given the user's UV_INDEX_URL, want none of the user's uv variables")
	}
	if given := readText(t, filepath.Join(log, "requirements")); given != string(requirements) {
		t.Errorf("uv was given requirements other than the locked ones:\n%s", given)
	}
	if _, err := os.Stat(filepath.Join(folder.Path, "cache")); !os.IsNotExist(err) {
		t.Errorf("uv's cache: %v, want it gone once aip is installed", err)
	}
}

func TestTheLockPinsEveryRequirementByVersionAndHash(t *testing.T) {
	entries := regexp.MustCompile(`(?m)^[A-Za-z0-9._-]+==[^ ]+ \\\n(    --hash=sha256:[0-9a-f]{64}( \\)?\n)+`).FindAllString(string(requirements), -1)
	if len(entries) == 0 || !strings.Contains(string(requirements), "\nagent-instruction-protocol==0.7.0 \\\n") {
		t.Fatalf("the lock pins no agent-instruction-protocol==0.7.0 by hash")
	}
	requirementLines := regexp.MustCompile(`(?m)^[A-Za-z0-9._-]+==`).FindAllString(string(requirements), -1)
	if len(entries) != len(requirementLines) {
		t.Errorf("%d requirements, %d of them pinned by hash: want every one", len(requirementLines), len(entries))
	}
}

func TestTheHostsAipUvAndPythonAreTheOnesTheSessionImageShips(t *testing.T) {
	containerfile := readText(t, filepath.Join("..", "..", "..", "packages", "trierarch", "image", "Containerfile"))

	aip := regexp.MustCompile(`(?m)^ARG AIP_VERSION=(\S+)$`).FindStringSubmatch(containerfile)
	python := regexp.MustCompile(`(?m)^ARG PYTHON_VERSION=(\S+)$`).FindStringSubmatch(containerfile)
	if aip == nil || aip[1] != Version {
		t.Errorf("the image ships aip %v, the host gets %s: want the same", aip, Version)
	}
	if python == nil || !strings.HasPrefix(PythonVersion, python[1]+".") {
		t.Errorf("the image ships Python %v, the host gets %s: want the same minor", python, PythonVersion)
	}
	if !strings.Contains(containerfile, "ghcr.io/astral-sh/uv:"+UvVersion+" ") {
		t.Errorf("the image takes another uv than the host's %s", UvVersion)
	}
}

func TestEveryUvBuildIsOfThePinnedVersionAndCheckedByItsPublishedSha256(t *testing.T) {
	for _, platform := range [][2]string{{"linux", "amd64"}, {"linux", "arm64"}, {"darwin", "amd64"}, {"darwin", "arm64"}} {
		build, ok := UvFor(platform[0], platform[1])
		if !ok || !strings.HasPrefix(build.URL, "https://github.com/astral-sh/uv/releases/download/0.13.7/uv-") || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(build.SHA256) {
			t.Errorf("UvFor(%s) = %+v, %v; want uv 0.13.7 from its release with its sha256", platform, build, ok)
		}
	}
	if build, ok := UvFor("linux", "386"); ok {
		t.Errorf("UvFor(linux/386) = %+v, want none: uv has no build for it", build)
	}
}

func TestAnInstalledFolderOfThePinIsKeptAsItIs(t *testing.T) {
	folder, log := aFolder(t)
	folder.Ensure()

	state := folder.Ensure()

	if state != (State{Version: "0.7.0"}) || pipRuns(log) != 1 {
		t.Errorf("Ensure() again = %+v after %d pip runs, want 0.7.0 kept from the one install", state, pipRuns(log))
	}
}

func TestAFolderWhoseAipIsGoneIsBrokenAndInstalledAgain(t *testing.T) {
	folder, log := aFolder(t)
	folder.Ensure()
	if err := os.Remove(filepath.Join(folder.Path, "venv", "bin", "aip")); err != nil {
		t.Fatal(err)
	}
	if _, ok := folder.Bin(); ok {
		t.Fatalf("Bin() of a folder without its aip is offered, want none")
	}

	state := folder.Ensure()

	bin, ok := folder.Bin()
	if state != (State{Version: "0.7.0"}) || !ok || pipRuns(log) != 2 || aipVersionIn(t, bin) != "aip 0.7.0 format 0.6a1" {
		t.Errorf("Ensure() = %+v, Bin() = %v after %d pip runs, want 0.7.0 installed again", state, ok, pipRuns(log))
	}
}

func TestAFolderWhosePythonIsGoneIsBrokenAndInstalledAgain(t *testing.T) {
	folder, log := aFolder(t)
	folder.Ensure()
	if err := os.RemoveAll(filepath.Join(folder.Path, "python")); err != nil {
		t.Fatal(err)
	}
	if _, ok := folder.Bin(); ok {
		t.Fatalf("Bin() of a folder whose venv's Python is gone is offered, want none")
	}

	if state := folder.Ensure(); state != (State{Version: "0.7.0"}) || pipRuns(log) != 2 {
		t.Errorf("Ensure() = %+v after %d pip runs, want 0.7.0 installed again", state, pipRuns(log))
	}
}

func TestAFolderWhoseAipStatesAnotherVersionIsBrokenAndInstalledAgain(t *testing.T) {
	folder, log := aFolder(t)
	folder.Ensure()
	if err := os.WriteFile(filepath.Join(folder.Path, "venv", "bin", "aip"), []byte("#!/bin/sh\necho 'aip 0.6.0 format 0.5'\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	state := folder.Ensure()

	bin, _ := folder.Bin()
	if state != (State{Version: "0.7.0"}) || pipRuns(log) != 2 || aipVersionIn(t, bin) != "aip 0.7.0 format 0.6a1" {
		t.Errorf("Ensure() = %+v after %d pip runs, want 0.7.0 installed again", state, pipRuns(log))
	}
}

func TestAFolderOfAnEarlierPinIsNotOfferedAndIsInstalledAtTheNewPin(t *testing.T) {
	folder, log := aFolder(t)
	folder.Ensure()
	if err := os.WriteFile(folder.Outcome, []byte(`{"version":"0.6.0"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := folder.Bin(); ok {
		t.Fatalf("Bin() of a folder of aip 0.6.0 is offered, want none")
	}

	state := folder.Ensure()

	if _, ok := folder.Bin(); state != (State{Version: "0.7.0"}) || !ok || pipRuns(log) != 2 {
		t.Errorf("Ensure() = %+v, Bin() = %v after %d pip runs, want 0.7.0 installed", state, ok, pipRuns(log))
	}
}

func TestAMachineUvHasNoBuildForGetsNoAipAndSaysWhy(t *testing.T) {
	folder, _ := aFolder(t)
	folder.Uv = nil

	state := folder.Ensure()

	if _, ok := folder.Bin(); state != (State{Missing: "uv 0.13.7, which installs aip 0.7.0, has no build for this machine"}) || ok {
		t.Errorf("Ensure() = %+v, Bin() = %v, want no aip and why", state, ok)
	}
	if folder.State() != state {
		t.Errorf("State() = %+v, want what Ensure said: %+v", folder.State(), state)
	}
}

func TestADownloadOfUvThatDoesNotMatchItsSha256IsNeverRun(t *testing.T) {
	folder, log := aFolder(t)
	folder.Uv.SHA256 = strings.Repeat("0", 64)

	state := folder.Ensure()

	if state != (State{Missing: "the install of aip 0.7.0 failed: uv 0.13.7's download does not match its sha256"}) {
		t.Errorf("Ensure() = %+v, want the download refused", state)
	}
	if _, err := os.Stat(filepath.Join(log, "words")); !os.IsNotExist(err) {
		t.Errorf("uv ran (%v), want a download that does not match never run", err)
	}
	if _, err := os.Stat(folder.Path); !os.IsNotExist(err) {
		t.Errorf("%s: %v, want no folder left of a failed install", folder.Path, err)
	}
}

func TestAMachineWithNoNetworkGetsNoAipLogsWhyAndTriesAgainOnceItHasOne(t *testing.T) {
	folder, _ := aFolder(t)
	reachable := folder.Uv.URL
	folder.Uv.URL = "http://127.0.0.1:1/uv.tar.gz"
	logged := []string{}
	folder.Log = func(line string) { logged = append(logged, line) }

	state := folder.Ensure()

	if !strings.HasPrefix(state.Missing, "the install of aip 0.7.0 failed: uv 0.13.7 could not be downloaded: ") || len(logged) != 1 || logged[0] != state.Missing {
		t.Errorf("Ensure() = %+v, logged %q; want the failed download said and logged", state, logged)
	}
	folder.Uv.URL = reachable
	if again := folder.Ensure(); again != (State{Version: "0.7.0"}) {
		t.Errorf("Ensure() once the network is back = %+v, want 0.7.0", again)
	}
}

func TestAFailedInstallIsLoggedWithUvsOwnWordsAndLeavesNoFolder(t *testing.T) {
	folder, log := aFolder(t)
	if err := os.WriteFile(filepath.Join(log, "PIP_FAILS"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	logged := []string{}
	folder.Log = func(line string) { logged = append(logged, line) }

	state := folder.Ensure()

	if !strings.HasPrefix(state.Missing, "the install of aip 0.7.0 failed: ") || !strings.Contains(state.Missing, "hash mismatch for typing-extensions") || state.Version != "" {
		t.Errorf("Ensure() = %+v, want the install failed with uv's own words", state)
	}
	if len(logged) != 1 || logged[0] != state.Missing {
		t.Errorf("logged %q, want the failure", logged)
	}
	if _, err := os.Stat(folder.Path); !os.IsNotExist(err) {
		t.Errorf("%s: %v, want no folder left of a failed install", folder.Path, err)
	}
}

func TestAFolderNeverEnsuredIsNotInstalledYet(t *testing.T) {
	folder, _ := aFolder(t)

	if _, ok := folder.Bin(); ok || folder.State() != (State{Missing: "aip 0.7.0 is not installed yet"}) {
		t.Errorf("Bin() = %v, State() = %+v, want not installed yet", ok, folder.State())
	}
}

// TestTheRealUvInstallsTheRealAip downloads uv, CPython and aip from their releases into a throwaway folder, only with AEOLUS_TEST_AIP_INSTALL=1.
func TestTheRealUvInstallsTheRealAip(t *testing.T) {
	if os.Getenv("AEOLUS_TEST_AIP_INSTALL") != "1" {
		t.Skip("downloads uv, CPython and aip: only with AEOLUS_TEST_AIP_INSTALL=1")
	}
	uv, ok := UvFor(runtime.GOOS, runtime.GOARCH)
	if !ok {
		t.Skipf("uv has no build for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	home := t.TempDir()
	// uv may look in the home and the XDG folders: each is a throwaway one, so nothing is written outside them.
	for _, variable := range []string{"HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_BIN_HOME", "XDG_STATE_HOME"} {
		t.Setenv(variable, t.TempDir())
	}
	folder := Folder{Path: filepath.Join(home, "aip-command"), Outcome: filepath.Join(home, "aip-command.json"), Uv: &uv}

	state := folder.Ensure()

	bin, isHeld := folder.Bin()
	if state != (State{Version: Version}) || !isHeld || !strings.HasPrefix(aipVersionIn(t, bin), "aip "+Version+" ") {
		t.Fatalf("Ensure() = %+v, Bin() = %q, %v; want aip %s", state, bin, isHeld, Version)
	}
	plugin, _ := folder.Plugin()
	for _, skill := range []string{"aip-compile", "aip-runtime"} {
		if text := readText(t, filepath.Join(plugin, "skills", skill, "SKILL.md")); !strings.Contains(text, "\nname: "+skill+"\n") {
			t.Errorf("%s's SKILL.md does not name it: %q", skill, text[:min(len(text), 200)])
		}
	}
}

func TestAFailedInstallsWordsAreOneLine(t *testing.T) {
	folder, log := aFolder(t)
	if err := os.WriteFile(filepath.Join(log, "PIP_FAILS"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	if state := folder.Ensure(); strings.Contains(state.Missing, "\n") {
		t.Errorf("Ensure() = %q, want one line", state.Missing)
	}
}

func TestAnInstallInAnotherProcessIsWaitedForAndNeitherUndoesTheOther(t *testing.T) {
	folder, log := aFolder(t)
	if err := os.WriteFile(filepath.Join(log, "SLOW"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	other := exec.Command(program)
	other.Env = append(os.Environ(), "AIPCOMMAND_INSTALLER="+folder.Path, "AIPCOMMAND_OUTCOME="+folder.Outcome, "AIPCOMMAND_UV_URL="+folder.Uv.URL, "AIPCOMMAND_UV_SHA256="+folder.Uv.SHA256)
	var said bytes.Buffer
	other.Stdout = &said
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	for until := time.Now().Add(5 * time.Second); pipRuns(log) == 0 && time.Now().Before(until); time.Sleep(10 * time.Millisecond) {
	}

	state := folder.Ensure()

	if err := other.Wait(); err != nil {
		t.Fatalf("the other installer: %v", err)
	}
	var otherState State
	if err := json.Unmarshal(said.Bytes(), &otherState); err != nil {
		t.Fatalf("the other installer said %q: %v", said.String(), err)
	}
	bin, ok := folder.Bin()
	if state != (State{Version: "0.7.0"}) || otherState != (State{Version: "0.7.0"}) || !ok || pipRuns(log) != 1 || aipVersionIn(t, bin) != "aip 0.7.0 format 0.6a1" {
		t.Errorf("this process = %+v, the other = %+v, Bin() = %v after %d pip runs; want one install that both see as 0.7.0", state, otherState, ok, pipRuns(log))
	}
}

func TestBriefIsWhyThereIsNoAipAsShortAsAReportsNoteTakesIt(t *testing.T) {
	for _, test := range []struct {
		state State
		want  string
	}{
		{State{Version: "0.7.0"}, ""},
		{State{Missing: "uv 0.13.7, which installs aip 0.7.0, has no build for this machine"}, "uv 0.13.7, which installs aip 0.7.0, has no build for this machine"},
		{State{Missing: "aip 0.7.0 is not installed yet"}, "aip 0.7.0 is not installed yet"},
		{State{Missing: "the install of aip 0.7.0 failed: uv 0.13.7 could not be downloaded: " + strings.Repeat("x", 300)}, "its install failed, as aeolus-trierarch status says"},
	} {
		if got := test.state.Brief(); got != test.want {
			t.Errorf("Brief() of %+v = %q, want %q", test.state, got, test.want)
		}
	}
}

func TestTheInstallWritesAipsSkillsIntoAPluginInTheFolder(t *testing.T) {
	folder, _ := aFolder(t)

	folder.Ensure()

	plugin, ok := folder.Plugin()
	if !ok || plugin != filepath.Join(folder.Path, "plugin") {
		t.Fatalf("Plugin() = %q, %v; want %s/plugin", plugin, ok, folder.Path)
	}
	for _, skill := range []string{"aip-compile", "aip-runtime"} {
		if text := readText(t, filepath.Join(plugin, "skills", skill, "SKILL.md")); !strings.Contains(text, "name: "+skill+"\n") {
			t.Errorf("%s's SKILL.md = %q, want aip's own", skill, text)
		}
	}
	var manifest map[string]any
	if err := json.Unmarshal([]byte(readText(t, filepath.Join(plugin, ".claude-plugin", "plugin.json"))), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest["name"] != "aip" || manifest["version"] != "0.7.0" {
		t.Errorf("the plugin's manifest = %v, want the plugin aip at 0.7.0", manifest)
	}
}

func TestAipsSkillsInstallWritesNothingIntoTheUsersHome(t *testing.T) {
	folder, _ := aFolder(t)
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(userHome, ".config"))

	folder.Ensure()

	if written, _ := os.ReadDir(userHome); len(written) != 0 {
		t.Errorf("the user's home holds %v after the install, want nothing written there", written)
	}
	if _, err := os.Stat(filepath.Join(folder.Path, "aip-home", ".aip", "skills.json")); err != nil {
		t.Errorf("aip's record of its skills: %v, want it in the folder's own aip-home", err)
	}
}

func TestAFolderWithoutAipsSkillsIsBrokenAndInstalledAgain(t *testing.T) {
	folder, log := aFolder(t)
	folder.Ensure()
	if err := os.RemoveAll(filepath.Join(folder.Path, "plugin")); err != nil {
		t.Fatal(err)
	}
	if _, ok := folder.Bin(); ok {
		t.Fatalf("Bin() of a folder without aip's skills is offered, want none")
	}

	state := folder.Ensure()

	if _, ok := folder.Plugin(); state != (State{Version: "0.7.0"}) || !ok || pipRuns(log) != 2 {
		t.Errorf("Ensure() = %+v, Plugin() = %v after %d pip runs, want 0.7.0 and its skills installed again", state, ok, pipRuns(log))
	}
}

func TestAFailedInstallOfAipsSkillsFailsTheInstall(t *testing.T) {
	folder, log := aFolder(t)
	if err := os.WriteFile(filepath.Join(log, "SKILLS_FAIL"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	state := folder.Ensure()

	if !strings.HasPrefix(state.Missing, "the install of aip 0.7.0 failed: aip skill install ended with ") || !strings.Contains(state.Missing, "cannot write") {
		t.Errorf("Ensure() = %+v, want the install failed with aip's own words", state)
	}
	if _, ok := folder.Plugin(); ok {
		t.Errorf("Plugin() is offered after a failed install, want none")
	}
}
