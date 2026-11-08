package aipcommand

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// standInPython is a python3 on a stand-in machine: it states its version, makes a venv of itself, and as the venv's python runs pip, which keeps
// its words and the requirements it was given in the venv and writes a bin/aip that states the version the requirements pin. STAND_IN_PIP_FAILS
// in the folder of the stand-in makes pip fail; every pip run is counted in pip-runs beside it.
const standInPython = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
case "$1" in
  -c) echo "%s" ;;
  -m)
    case "$2" in
      venv) mkdir -p "$3/bin" && cp "$0" "$3/bin/python" && echo "$here" > "$3/bin/stand-in-root" ;;
      pip)
        root=$(cat "$here/stand-in-root")
        echo run >> "$root/pip-runs"
        if [ -e "$root/STAND_IN_PIP_FAILS" ]; then echo "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES" >&2; exit 1; fi
        shift 2
        echo "$@" > "$here/../pip-words"
        while [ $# -gt 0 ]; do [ "$1" = -r ] && cp "$2" "$here/../pip-requirements"; shift; done
        version=$(sed -n 's/^agent-instruction-protocol==\([^ ]*\).*/\1/p' "$here/../pip-requirements")
        printf '#!/bin/sh\necho "aip %s (stand-in)"\n' "$version" > "$here/aip" && chmod +x "$here/aip" ;;
    esac ;;
esac
`

// aMachine is a PATH with a python3 of the version, and the folder it is in.
func aMachine(t *testing.T, version string) (path string, bin string) {
	t.Helper()
	bin = t.TempDir()
	writePython(t, filepath.Join(bin, "python3"), version)
	return bin + string(os.PathListSeparator) + "/usr/bin:/bin", bin
}

func writePython(t *testing.T, path string, version string) {
	t.Helper()
	script := strings.Replace(standInPython, "%s", version, 1)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func aFolder(t *testing.T, path string) Folder {
	t.Helper()
	home := t.TempDir()
	return Folder{Path: filepath.Join(home, "aip-command"), Outcome: filepath.Join(home, "aip-command.json"), SearchPath: path}
}

func aipVersionIn(t *testing.T, bin string) string {
	t.Helper()
	said, err := exec.Command(filepath.Join(bin, "aip"), "--version").Output()
	if err != nil {
		t.Fatalf("%s/aip --version: %v", bin, err)
	}
	return strings.TrimSpace(string(said))
}

func pipRuns(t *testing.T, standIn string) int {
	t.Helper()
	text, _ := os.ReadFile(filepath.Join(standIn, "pip-runs"))
	return strings.Count(string(text), "run")
}

func TestThePinnedAipIsInstalledIntoTheFolderAndItsBinRunsIt(t *testing.T) {
	path, _ := aMachine(t, "3.14")
	folder := aFolder(t, path)

	state := folder.Ensure()

	bin, ok := folder.Bin()
	if state != (State{Version: "0.7.0"}) || !ok || bin != filepath.Join(folder.Path, "bin") {
		t.Fatalf("Ensure() = %+v, Bin() = %q, %v; want 0.7.0 in %s/bin", state, bin, ok, folder.Path)
	}
	if got := aipVersionIn(t, bin); got != "aip 0.7.0 (stand-in)" {
		t.Errorf("aip --version = %q, want aip 0.7.0", got)
	}
}

func TestPipInstallsOnlyTheLockedRequirementsEachByItsHashIntoTheFolderNeverTheUsersPython(t *testing.T) {
	path, _ := aMachine(t, "3.14")
	folder := aFolder(t, path)

	folder.Ensure()

	words := readText(t, filepath.Join(folder.Path, "pip-words"))
	for _, want := range []string{"install", "--require-hashes", "--no-deps", "--only-binary=:all:", "--isolated"} {
		if !strings.Contains(" "+words+" ", " "+want+" ") {
			t.Errorf("pip was given %q, want %s among them", words, want)
		}
	}
	if given := readText(t, filepath.Join(folder.Path, "pip-requirements")); given != string(requirements) {
		t.Errorf("pip was given requirements other than the locked ones:\n%s", given)
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

func TestTheHostsAipIsTheVersionTheSessionImageShips(t *testing.T) {
	containerfile := readText(t, filepath.Join("..", "..", "..", "packages", "trierarch", "image", "Containerfile"))

	match := regexp.MustCompile(`(?m)^ARG AIP_VERSION=(\S+)$`).FindStringSubmatch(containerfile)
	if match == nil || match[1] != Version {
		t.Errorf("the image ships aip %v, the host gets %s: want the same", match, Version)
	}
}

func TestAnInstalledFolderOfThePinIsKeptAsItIs(t *testing.T) {
	path, standIn := aMachine(t, "3.14")
	folder := aFolder(t, path)
	folder.Ensure()

	state := folder.Ensure()

	if state != (State{Version: "0.7.0"}) || pipRuns(t, standIn) != 1 {
		t.Errorf("Ensure() again = %+v after %d pip runs, want 0.7.0 kept from the one install", state, pipRuns(t, standIn))
	}
}

func TestAFolderWhoseAipIsGoneIsBrokenAndInstalledAgain(t *testing.T) {
	path, standIn := aMachine(t, "3.14")
	folder := aFolder(t, path)
	folder.Ensure()
	if err := os.Remove(filepath.Join(folder.Path, "bin", "aip")); err != nil {
		t.Fatal(err)
	}
	if _, ok := folder.Bin(); ok {
		t.Fatalf("Bin() of a folder without its aip is offered, want none")
	}

	state := folder.Ensure()

	bin, ok := folder.Bin()
	if state != (State{Version: "0.7.0"}) || !ok || pipRuns(t, standIn) != 2 || aipVersionIn(t, bin) != "aip 0.7.0 (stand-in)" {
		t.Errorf("Ensure() = %+v, Bin() = %v after %d pip runs, want 0.7.0 installed again", state, ok, pipRuns(t, standIn))
	}
}

func TestAFolderWhoseAipStatesAnotherVersionIsBrokenAndInstalledAgain(t *testing.T) {
	path, standIn := aMachine(t, "3.14")
	folder := aFolder(t, path)
	folder.Ensure()
	if err := os.WriteFile(filepath.Join(folder.Path, "bin", "aip"), []byte("#!/bin/sh\necho 'aip 0.6.0 (stand-in)'\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	state := folder.Ensure()

	bin, _ := folder.Bin()
	if state != (State{Version: "0.7.0"}) || pipRuns(t, standIn) != 2 || aipVersionIn(t, bin) != "aip 0.7.0 (stand-in)" {
		t.Errorf("Ensure() = %+v after %d pip runs, want 0.7.0 installed again", state, pipRuns(t, standIn))
	}
}

func TestAFolderOfAnEarlierPinIsNotOfferedAndIsInstalledAtTheNewPin(t *testing.T) {
	path, standIn := aMachine(t, "3.14")
	folder := aFolder(t, path)
	folder.Ensure()
	if err := os.WriteFile(folder.Outcome, []byte(`{"version":"0.6.0"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := folder.Bin(); ok {
		t.Fatalf("Bin() of a folder of aip 0.6.0 is offered, want none")
	}

	state := folder.Ensure()

	if _, ok := folder.Bin(); state != (State{Version: "0.7.0"}) || !ok || pipRuns(t, standIn) != 2 {
		t.Errorf("Ensure() = %+v, Bin() = %v after %d pip runs, want 0.7.0 installed", state, ok, pipRuns(t, standIn))
	}
}

func TestAHostWithoutPython3GetsNoAipAndSaysWhy(t *testing.T) {
	folder := aFolder(t, t.TempDir())

	state := folder.Ensure()

	if _, ok := folder.Bin(); state != (State{Missing: "no python3 on the PATH, and aip 0.7.0 runs on Python 3.14 or newer"}) || ok {
		t.Errorf("Ensure() = %+v, Bin() = %v, want no aip and why", state, ok)
	}
	if folder.State() != state {
		t.Errorf("State() = %+v, want what Ensure said: %+v", folder.State(), state)
	}
}

func TestAHostWhosePython3IsOlderThan314GetsNoAipAndSaysWhy(t *testing.T) {
	path, _ := aMachine(t, "3.12")
	folder := aFolder(t, path)

	state := folder.Ensure()

	if _, ok := folder.Bin(); state != (State{Missing: "python3 on the PATH is 3.12, and aip 0.7.0 runs on Python 3.14 or newer"}) || ok {
		t.Errorf("Ensure() = %+v, Bin() = %v, want no aip and why", state, ok)
	}
}

func TestAHostWhosePython3IsOlderTakesItsPython314(t *testing.T) {
	path, bin := aMachine(t, "3.12")
	writePython(t, filepath.Join(bin, "python3.14"), "3.14")
	folder := aFolder(t, path)

	state := folder.Ensure()

	if _, ok := folder.Bin(); state != (State{Version: "0.7.0"}) || !ok {
		t.Errorf("Ensure() = %+v, Bin() = %v, want 0.7.0 on python3.14", state, ok)
	}
}

func TestAFailedInstallIsLoggedLeavesNoFolderAndIsTriedAgain(t *testing.T) {
	path, standIn := aMachine(t, "3.14")
	if err := os.WriteFile(filepath.Join(standIn, "STAND_IN_PIP_FAILS"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	folder := aFolder(t, path)
	logged := []string{}
	folder.Log = func(line string) { logged = append(logged, line) }

	state := folder.Ensure()

	if !strings.HasPrefix(state.Missing, "the install of aip 0.7.0 failed: ") || !strings.Contains(state.Missing, "DO NOT MATCH THE HASHES") || state.Version != "" {
		t.Errorf("Ensure() = %+v, want the install failed with pip's own words", state)
	}
	if len(logged) != 1 || logged[0] != state.Missing {
		t.Errorf("logged %q, want the failure", logged)
	}
	if _, err := os.Stat(folder.Path); !os.IsNotExist(err) {
		t.Errorf("%s: %v, want no folder left of a failed install", folder.Path, err)
	}
	if err := os.Remove(filepath.Join(standIn, "STAND_IN_PIP_FAILS")); err != nil {
		t.Fatal(err)
	}
	if again := folder.Ensure(); again != (State{Version: "0.7.0"}) {
		t.Errorf("Ensure() once pip works = %+v, want 0.7.0", again)
	}
}

func TestAFolderNeverEnsuredIsNotInstalledYet(t *testing.T) {
	folder := aFolder(t, t.TempDir())

	if _, ok := folder.Bin(); ok || folder.State() != (State{Missing: "aip 0.7.0 is not installed yet"}) {
		t.Errorf("Bin() = %v, State() = %+v, want not installed yet", ok, folder.State())
	}
}

func readText(t *testing.T, path string) string {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}
