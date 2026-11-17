package cli

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
)

// anEchoingTerminal answers one typed line per read and shows it as typed, as a person's terminal does, so its text reads as the screen.
type anEchoingTerminal struct {
	lines []string
	bytes.Buffer
}

func (e *anEchoingTerminal) Read(p []byte) (int, error) {
	if len(e.lines) == 0 {
		return 0, io.EOF
	}
	line := e.lines[0] + "\n"
	e.lines = e.lines[1:]
	e.WriteString(line)
	return copy(p, line), nil
}

func (e *anEchoingTerminal) Close() error { return nil }

// aFreshComputer is the approved example: Claude Code and Codex installed and signed in, Copilot not installed, ~/code/web a git repository, nothing set up yet.
func aFreshComputer(t *testing.T, typed ...string) (*aMachine, *anEchoingTerminal) {
	t.Helper()
	m := newMachine(t)
	withCodex(m, true)
	m.init.HomeDirectory = t.TempDir()
	m.init.Program = "/opt/bin/aeolus-trierarch"
	m.init.Path = "/opt/bin:/usr/bin"
	m.init.InstallVerification = "attested"
	aGitRepository(t, filepath.Join(m.init.HomeDirectory, "code", "web"))
	terminal := &anEchoingTerminal{lines: typed}
	m.init.OpenTerminal = func() (io.ReadWriteCloser, error) { return terminal, nil }
	return m, terminal
}

// aLineAskingEverything is the setup line with no wizard choice answered.
func aLineAskingEverything() Flags {
	return Flags{FleetURL: fleetURL, ShipID: shipID, Secret: secret, PluginShipID: pluginShipID}
}

// screenOf is what the person sees: the terminal, then what init prints as it ends, or its error.
func screenOf(terminal *anEchoingTerminal, report Report, err error) string {
	if err != nil && len(report.Checks) == 0 {
		return terminal.String() + err.Error() + "\n"
	}
	return terminal.String() + strings.Join(report.Said, "\n") + "\n"
}

const approvedA1 = `Join this computer to your fleet

The trierarch runs agent sessions on this computer. Each session crews
one ship: an agent you can send work to through the fleet.
Sessions use the tools, files and permissions you allow here.

Setup has four parts:
  1. Agent tools and permissions
  2. Repositories and folders
  3. Ship and session limits
  4. Service and connection

Enter accepts the shown default. Type ? for help at a setup question.
Ctrl+C stops setup. Installed files may remain; see the closing status.

Part 1 of 4: Agent tools and permissions
An agent tool (a harness) runs the sessions. Pick at least one.
Claude Code: installed, signed in.
Use Claude Code? [y/N] y
Codex: installed, signed in.
Use Codex? [y/N] y
Copilot: not installed.
Use Copilot? [y/N] n

Claude Code normally uses its own permission controls.
Yes lets its sessions run tools without permission questions, with
this computer user's access. It also accepts Claude Code's bypass
warning for this user. Other Claude Code runs may see that acceptance.
No keeps normal permission controls; work may be refused or wait.
Run Claude Code without permission questions? [y/N] n

Codex normally uses its own approvals and sandbox.
Yes bypasses both for sessions started by this trierarch, with this
computer user's access. No keeps normal controls; work may be refused
or wait.
Run Codex without permission questions? [y/N] n
`

const approvedA2 = `
Part 2 of 4: Repositories and folders
For a repository, each ship gets its own git worktree.
A folder used as it is is shared: a session can change its existing files.
These choices select workspaces; they do not sandbox a session's access.

Add repositories from:
  1. Local repository paths or git URLs
  2. A folder containing git repositories (direct children only)
  3. Skip adding repositories
Choose [3]: 1
Git URLs are cloned to ~/repositories unless --clone-into sets another
folder. Local repositories stay where they are.
Local paths or git URLs (comma or semicolon separated): ~/code/web
Added repository web: ~/code/web

Add a folder used as it is? [y/N] ?
A session uses the folder directly, without making a git worktree.
Other sessions or people using it see changes to the same files.
Choose No if you only want the repositories above. Default: No.
Add a folder used as it is? [y/N] n
`

const approvedA3 = `
Part 3 of 4: Ship and session limits
The ship limit is how many ships this trierarch may keep on its list,
including ships whose sessions are not running. Fresh default: 4.
How many ships may it keep on its list? [4] 4

The session limit is how many sessions may run at the same time.
Other ships wait for a place. Fresh default: 2.
How many sessions may run at once? [2] 2
`

const approvedA4 = `
Part 4 of 4: Service and connection
The service runs the trierarch in the background and starts it again
at login. It can start sessions when the fleet assigns work here.
Yes installs and starts it. No stops before joining this computer;
this run will not register it or install or start its service.
Downloaded files and cloned repositories may remain.
Install and start the service? [Y/n] y

Installing the Aeolus Fleet plugin for Claude Code...
Installing the Aeolus Fleet plugin for Codex...
Joining the fleet...
Saving this computer's configuration...
Starting the service...
Checking that the service stays running (at least 10 seconds)...

Ready: this computer is joined to the fleet.
  Claude Code: normal permission controls
  Codex: normal approvals and sandbox
  Repositories: web
  Folders: none
  Limits: 4 ships, 2 sessions at once
  Service: running; starts again at login
Check this computer with: aeolus-trierarch status
`

// theApprovedAnswers are the example person's answers in A1 to A4.
var theApprovedAnswers = []string{"y", "y", "n", "n", "n", "1", "~/code/web", "?", "n", "4", "2", "y"}

func TestSetupShowsTheApprovedScreensOnAFreshComputer(t *testing.T) {
	m, terminal := aFreshComputer(t, theApprovedAnswers...)

	report, err := m.init.Run(aLineAskingEverything())

	if err != nil {
		t.Fatalf("Run() error = %v, screen:\n%s", err, terminal.String())
	}
	if got, want := screenOf(terminal, report, err), approvedA1+approvedA2+approvedA3+approvedA4; got != want {
		t.Errorf("screen:\n%s\nwant:\n%s", got, want)
	}
	got, _ := config.Load(m.init.Paths.Config)
	if got.Caps != (config.Caps{Ships: 4, Running: 2}) || len(got.Harnesses) != 2 || len(got.Harnesses["claude-code"].Flags) != 0 || len(got.Harnesses["codex"].Flags) != 0 {
		t.Errorf("configuration = %+v, want both harnesses with normal permission controls and limits 4 and 2", got)
	}
}

func TestSetupExplainsCopilotsHeadlessSessionsBeforeItsSelection(t *testing.T) {
	m, terminal := aFreshComputer(t, "n", "n", "y", "3", "n", "", "", "y")
	m.init.IsCopilotInstalled = true

	_, err := m.init.Run(aLineAskingEverything())

	if err != nil {
		t.Fatalf("Run() error = %v, screen:\n%s", err, terminal.String())
	}
	want := "Copilot: installed; sign-in cannot be checked here.\n" +
		"Copilot's headless sessions always run without tool permission questions.\n" +
		"They use this computer user's access. Pick No to leave Copilot out.\n" +
		"Use Copilot? [y/N] y\n"
	if !strings.Contains(terminal.String(), want) || strings.Contains(terminal.String(), "Run Copilot without permission questions?") {
		t.Errorf("screen:\n%s\nwant it to hold:\n%s and no Copilot permission question", terminal.String(), want)
	}
}

func TestSetupHelpAndInvalidInputDoNotAdvanceTheLimits(t *testing.T) {
	m, terminal := aFreshComputer(t, "y", "n", "n", "n", "3", "n", "", "?", "many", "2", "y")

	if _, err := m.init.Run(aLineAskingEverything()); err != nil {
		t.Fatalf("Run() error = %v, screen:\n%s", err, terminal.String())
	}
	want := "How many sessions may run at once? [2] ?\n" +
		"This limits sessions running at the same time on this computer.\n" +
		"Other ships wait for a place. Enter keeps 2.\n" +
		"How many sessions may run at once? [2] many\n" +
		"Enter a whole number greater than zero, or ? for help.\n" +
		"How many sessions may run at once? [2] 2\n"
	if !strings.Contains(terminal.String(), want) {
		t.Errorf("screen:\n%s\nwant it to hold:\n%s", terminal.String(), want)
	}
	if got := strings.Count(terminal.String(), "Part 3 of 4"); got != 1 {
		t.Errorf("Part 3 of 4 shown %d times, want once", got)
	}
}

func TestSetupAnswersHelpAtEveryQuestionAndAsksItAgain(t *testing.T) {
	var typed []string
	for _, answer := range []string{"y", "y", "n", "n", "n", "1", "~/code/web", "y", "notes", "~/notes", "n", "4", "2", "y"} {
		typed = append(typed, "?", answer)
	}
	m, terminal := aFreshComputer(t, typed...)
	if err := os.MkdirAll(filepath.Join(m.init.HomeDirectory, "notes"), 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := m.init.Run(aLineAskingEverything()); err != nil {
		t.Fatalf("Run() error = %v, screen:\n%s", err, terminal.String())
	}
	for _, prompt := range []string{"Use Claude Code? [y/N] ", "Use Codex? [y/N] ", "Use Copilot? [y/N] ", "Run Claude Code without permission questions? [y/N] ", "Run Codex without permission questions? [y/N] ", "Choose [3]: ", "Local paths or git URLs (comma or semicolon separated): ", "Folder name: ", "Folder path: ", "How many ships may it keep on its list? [4] ", "How many sessions may run at once? [2] ", "Install and start the service? [Y/n] "} {
		if got := strings.Count(terminal.String(), prompt+"?\n"); got != 1 {
			t.Errorf("%q answered help %d times, want once:\n%s", prompt, got, terminal.String())
		}
	}
	got, _ := config.Load(m.init.Paths.Config)
	if len(got.Harnesses) != 2 || got.Repositories["web"].Path == "" || got.Folders["notes"].Path != filepath.Join(m.init.HomeDirectory, "notes") || got.Caps != (config.Caps{Ships: 4, Running: 2}) {
		t.Errorf("configuration = %+v, want every answer kept after help", got)
	}
}

func TestSetupAddsFoldersUsedAsTheyAreAskingAgainForWhatIsWrong(t *testing.T) {
	m, terminal := aFreshComputer(t, "y", "n", "n", "n", "1", "~/code/web", "y", "Notes", "web", "notes", "~/missing", "~/notes", "y", "shared", "~/shared", "n", "", "", "y")
	for _, folder := range []string{"notes", "shared"} {
		if err := os.MkdirAll(filepath.Join(m.init.HomeDirectory, folder), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := m.init.Run(aLineAskingEverything()); err != nil {
		t.Fatalf("Run() error = %v, screen:\n%s", err, terminal.String())
	}
	for _, want := range []string{
		"Folder name: Notes\nNotes is not a valid name.",
		"Folder name: web\nweb names repository web already: choose a different name.\nFolder name: notes\n",
		"Folder path: ~/missing\n~/missing is not a folder.\nFolder path: ~/notes\nAdded folder notes: ~/notes\n",
		"Added folder shared: ~/shared\n\nAdd a folder used as it is? [y/N] n\n",
	} {
		if !strings.Contains(terminal.String(), want) {
			t.Errorf("screen:\n%s\nwant it to hold:\n%s", terminal.String(), want)
		}
	}
	got, _ := config.Load(m.init.Paths.Config)
	if len(got.Folders) != 2 || got.Folders["shared"].Path != filepath.Join(m.init.HomeDirectory, "shared") {
		t.Errorf("folders = %+v, want notes and shared", got.Folders)
	}
}

func TestSetupSaysANoWorkspaceComputerCannotCrewARequestYet(t *testing.T) {
	m, terminal := aFreshComputer(t, "y", "n", "n", "n", "3", "n", "", "", "y")

	if _, err := m.init.Run(aLineAskingEverything()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if want := "Add a folder used as it is? [y/N] n\nNo workspace: this computer cannot crew a request until you add a repository or folder.\n"; !strings.Contains(terminal.String(), want) {
		t.Errorf("screen:\n%s\nwant it to hold:\n%s", terminal.String(), want)
	}
}

func TestSetupStopsAtAHarnessNotSignedInBeforeRegistration(t *testing.T) {
	m, terminal := aFreshComputer(t, "y", "n", "n")
	m.init.IsClaudeCodeSignedIn = false

	report, err := m.init.Run(aLineAskingEverything())

	want := "Part 1 of 4: Agent tools and permissions\n" +
		"An agent tool (a harness) runs the sessions. Pick at least one.\n" +
		"Claude Code: installed, not signed in.\n" +
		"Use Claude Code? [y/N] y\n" +
		"Codex: installed, signed in.\n" +
		"Use Codex? [y/N] n\n" +
		"Copilot: not installed.\n" +
		"Use Copilot? [y/N] n\n" +
		"Claude Code is installed but not signed in.\n" +
		"Run: claude auth login\n" +
		"Then run your setup line again.\n" +
		"Not joined: setup stopped before registration.\n"
	if err == nil || !strings.HasSuffix(screenOf(terminal, report, err), want) {
		t.Errorf("screen:\n%s\nwant it to end:\n%s", screenOf(terminal, report, err), want)
	}
	if len(m.fleet.registered) != 0 {
		t.Error("registered a ship")
	}
}

func TestSetupAsksAgainForAPathThatIsNotAGitRepository(t *testing.T) {
	m, terminal := aFreshComputer(t, "y", "n", "n", "n", "1", "~/code", "~/code/web", "n", "", "", "y")

	if _, err := m.init.Run(aLineAskingEverything()); err != nil {
		t.Fatalf("Run() error = %v, screen:\n%s", err, terminal.String())
	}
	want := "Local paths or git URLs (comma or semicolon separated): ~/code\n" +
		"~/code is not a git repository.\n" +
		"Enter a local git repository path or a git URL, or ? for help.\n" +
		"Local paths or git URLs (comma or semicolon separated): ~/code/web\n" +
		"Added repository web: ~/code/web\n"
	if !strings.Contains(terminal.String(), want) {
		t.Errorf("screen:\n%s\nwant it to hold:\n%s", terminal.String(), want)
	}
}

func TestSetupDeclinedServiceStopsBeforeJoining(t *testing.T) {
	m, terminal := aFreshComputer(t, "y", "n", "n", "n", "3", "n", "", "", "n")

	report, err := m.init.Run(aLineAskingEverything())

	want := "Part 4 of 4: Service and connection\n" +
		"The service runs the trierarch in the background and starts it again\n" +
		"at login. It can start sessions when the fleet assigns work here.\n" +
		"Yes installs and starts it. No stops before joining this computer;\n" +
		"this run will not register it or install or start its service.\n" +
		"Downloaded files and cloned repositories may remain.\n" +
		"Install and start the service? [Y/n] n\n" +
		"Stopped before joining: no registration or service change by this run.\n" +
		"Downloaded files and cloned repositories may remain.\n" +
		"Run your setup line again when you want to continue.\n"
	if err == nil || !strings.HasSuffix(screenOf(terminal, report, err), want) {
		t.Errorf("screen:\n%s\nwant it to end:\n%s", screenOf(terminal, report, err), want)
	}
	if len(m.fleet.registered) != 0 || len(m.plugins.updates) != 0 || len(m.service.calls) != 0 {
		t.Errorf("registered %v, plugin updates %v, service calls %v, want none", m.fleet.registered, m.plugins.updates, m.service.calls)
	}
	if _, statErr := os.Stat(m.init.Paths.Config); !errors.Is(statErr, os.ErrNotExist) {
		t.Error("saved a configuration")
	}
}

func TestSetupDeclinedUpdateLeavesTheExistingServiceAlone(t *testing.T) {
	m, terminal := aFreshComputer(t)
	if _, err := m.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}
	m.service.calls = nil
	terminal.lines = []string{"y", "n", "n", "n", "3", "n", "", "", "n"}
	terminal.Reset()

	report, err := m.init.Run(aLineAskingEverything())

	want := "Update and start the existing service? [Y/n] n\n" +
		"Stopped: no registration or service change by this run.\n" +
		"The existing service is unchanged and may still be running.\n" +
		"Downloaded files and cloned repositories may remain.\n" +
		"Run your setup line again when you want to continue.\n"
	if err == nil || !strings.HasSuffix(screenOf(terminal, report, err), want) {
		t.Errorf("screen:\n%s\nwant it to end:\n%s", screenOf(terminal, report, err), want)
	}
	if len(m.service.calls) != 0 || !m.service.running {
		t.Errorf("service calls %v, running %v, want it untouched and running", m.service.calls, m.service.running)
	}
}

func TestSetupShowsCurrentSettingsOnARerun(t *testing.T) {
	m, terminal := aFreshComputer(t)
	f := setupLine()
	f.Unattended = []string{"claude-code"}
	f.MaxShips, f.MaxRunning = "6", "3"
	if _, err := m.init.Run(f); err != nil {
		t.Fatal(err)
	}
	terminal.lines = []string{"", "n", "n", "", "3", "n", "", "", "y"}

	if _, err := m.init.Run(aLineAskingEverything()); err != nil {
		t.Fatalf("Run() error = %v, screen:\n%s", err, terminal.String())
	}
	for _, want := range []string{
		"Current setting: used.\nUse Claude Code? [Y/n] \n",
		"Current setting: yes, without permission questions.\nRun Claude Code without permission questions? [Y/n] \n",
		"including ships whose sessions are not running. Current setting: 6.\nHow many ships may it keep on its list? [6] \n",
		"Other ships wait for a place. Current setting: 3.\nHow many sessions may run at once? [3] \n",
	} {
		if !strings.Contains(terminal.String(), want) {
			t.Errorf("screen:\n%s\nwant it to hold:\n%s", terminal.String(), want)
		}
	}
	got, _ := config.Load(m.init.Paths.Config)
	if got.Caps != (config.Caps{Ships: 6, Running: 3}) || !slices.Contains(got.Harnesses["claude-code"].Flags, "--dangerously-skip-permissions") {
		t.Errorf("configuration = %+v, want the current settings kept", got)
	}
}

func TestSetupReportsAPluginThatCouldNotBeInstalledWithoutJoining(t *testing.T) {
	m, terminal := aFreshComputer(t, "y", "y", "n", "n", "n", "3", "n", "", "", "y")
	m.plugins.failing = errors.New("marketplace unreachable with " + secret)
	m.plugins.versions["claude-code"] = Version

	report, err := m.init.Run(aLineAskingEverything())

	want := "Installing the Aeolus Fleet plugin for Codex...\n" +
		"The Aeolus Fleet plugin could not be installed for Codex.\n" +
		"The installer reported: marketplace unreachable with <secret>\n" +
		"Not joined: this run did not register the computer or change its service.\n" +
		"Fix the reported cause, then run your setup line again.\n"
	if err == nil || !strings.HasSuffix(screenOf(terminal, report, err), want) {
		t.Errorf("screen:\n%s\nwant it to end:\n%s", screenOf(terminal, report, err), want)
	}
	if len(m.fleet.registered) != 0 || len(m.service.calls) != 0 {
		t.Error("registered or changed the service")
	}
}

func TestSetupSaysAnUnconfirmedRegistrationMayHaveBeenAccepted(t *testing.T) {
	m, terminal := aFreshComputer(t, "y", "n", "n", "n", "3", "n", "", "", "y")
	m.init.Register = func(string, string, string) (string, error) { return "", errors.New("connection reset") }

	report, err := m.init.Run(aLineAskingEverything())

	want := "Joining the fleet...\n" +
		"The fleet did not confirm registration.\n" +
		"It may have accepted it before the connection failed.\n" +
		"Run the same setup line again. If it reports that the ship is already\n" +
		"crewed here without a saved credential, use the recovery instructions\n" +
		"on the computer's ship page. No service was started by this run.\n"
	if err == nil || !strings.HasSuffix(screenOf(terminal, report, err), want) {
		t.Errorf("screen:\n%s\nwant it to end:\n%s", screenOf(terminal, report, err), want)
	}
	if len(m.service.calls) != 0 {
		t.Errorf("service calls = %v, want none", m.service.calls)
	}
}

func TestSetupIsNotReadyWhenTheServiceDoesNotStayRunning(t *testing.T) {
	m, terminal := aFreshComputer(t, "y", "n", "n", "n", "3", "n", "", "", "y")
	m.service.override = &service.Status{File: "/unit", IsInstalled: true}
	m.init.LastLog = func() string { return "exec format error" }

	report, err := m.init.Run(aLineAskingEverything())

	want := "Checking that the service stays running (at least 10 seconds)...\n\n" +
		"Not ready: the service did not stay running.\n" +
		"Last error: service is not running: last log line: exec format error\n" +
		"The computer is joined and its configuration is saved.\n" +
		"Check: aeolus-trierarch status\n" +
		"Fix the reported cause, then run the same setup line again.\n"
	if err == nil || !strings.HasSuffix(screenOf(terminal, report, err), want) {
		t.Errorf("screen:\n%s\nwant it to end:\n%s", screenOf(terminal, report, err), want)
	}
}

func TestSetupStopsBeforeRegistrationWhenTheTerminalCloses(t *testing.T) {
	m, terminal := aFreshComputer(t, "y", "n", "n", "n")

	report, err := m.init.Run(aLineAskingEverything())

	want := "Choose [3]: \n" +
		"Setup stopped: the terminal closed before an answer.\n" +
		"Not joined: setup stopped before registration.\n" +
		"Run your setup line again when you want to continue.\n"
	if err == nil || !strings.HasSuffix(screenOf(terminal, report, err), want) {
		t.Errorf("screen:\n%s\nwant it to end:\n%s", screenOf(terminal, report, err), want)
	}
	if len(m.fleet.registered) != 0 {
		t.Error("registered a ship")
	}
}

func TestSetupLineAnswersEveryChoiceAndShowsItsValues(t *testing.T) {
	machine, _, fleet := aMain(t)
	root := t.TempDir()
	shared := filepath.Join(root, "shared notes")
	if err := os.MkdirAll(shared, 0o755); err != nil {
		t.Fatal(err)
	}
	var printed []string
	machine.Print = func(line string) { printed = append(printed, line) }
	machine.OpenTerminal = func() (io.ReadWriteCloser, error) { return nil, errors.New("asked on the terminal") }
	words := []string{"init", "--fleet-url", fleetURL, "--ship-id", shipID, "--secret", secret, "--plugin-ship-id", pluginShipID, "--harnesses", "claude-code", "--unattended", "", "--no-repositories", "--folder", "shared", shared, "--folder", "notes", root, "--max-ships", "5", "--max-running", "1", "--service", "yes"}

	output, code := Main(words, machine)

	if code != 0 {
		t.Fatalf("init = %d, %s", code, output)
	}
	got, _ := config.Load(pathsOf(machine).Config)
	if got.Folders["shared"].Path != shared || got.Folders["notes"].Path != root || got.Caps != (config.Caps{Ships: 5, Running: 1}) || len(fleet.registered) != 1 {
		t.Errorf("configuration = %+v, registered %v", got, fleet.registered)
	}
	screen := strings.Join(printed, "\n")
	for _, want := range []string{"From the setup line: Claude Code.", "From the setup line: folder shared: " + shared, "From the setup line: 5.", "From the setup line: 1.", "From the setup line: install and start the service."} {
		if !strings.Contains(screen, want) {
			t.Errorf("printed:\n%s\nwant %q", screen, want)
		}
	}
	if strings.Contains(screen+output, secret) {
		t.Error("the secret was echoed")
	}
	if !strings.Contains(output, "  Folders: notes, shared") {
		t.Errorf("output = %s, want the folders listed", output)
	}
}

func TestSetupLineRefusesInvalidNewFlagsBeforeRegistration(t *testing.T) {
	root := t.TempDir()
	for _, tc := range []struct {
		name  string
		extra []string
		want  string
	}{
		{"folders and no folders", []string{"--folder", "notes", root, "--no-folders"}, "--folder or --no-folders"},
		{"invalid folder name", []string{"--folder", "Notes", root}, "Notes is not a valid name"},
		{"duplicate folder name", []string{"--folder", "notes", root, "--folder", "notes", root}, "notes is given twice"},
		{"missing folder", []string{"--folder", "notes", filepath.Join(root, "missing")}, "is not a folder"},
		{"unknown service answer", []string{"--service", "maybe"}, "--service takes yes or no"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			machine, _, fleet := aMain(t)
			output, code := Main(append(setupWords(), tc.extra...), machine)
			if code != 1 || !strings.Contains(output, tc.want) || !strings.Contains(output, "Not joined") {
				t.Errorf("init = %d, %s, want %q and not joined", code, output, tc.want)
			}
			if len(fleet.registered) != 0 {
				t.Error("registered a ship")
			}
		})
	}
}

func TestSetupLineServiceNoStopsBeforeJoiningAndNoFoldersAddsNone(t *testing.T) {
	machine, installed, fleet := aMain(t)

	output, code := Main(append(setupWords(), "--no-folders", "--service", "no"), machine)

	if code != 1 || !strings.Contains(output, "Stopped before joining: no registration or service change by this run.") {
		t.Errorf("init = %d, %s, want it stopped before joining", code, output)
	}
	if len(fleet.registered) != 0 || len(installed.calls) != 0 {
		t.Errorf("registered %v, service calls %v, want none", fleet.registered, installed.calls)
	}
}

func TestSetupWithoutATerminalKeepsFoldersAndInstallsTheService(t *testing.T) {
	m := newMachine(t)
	m.init.OpenTerminal = func() (io.ReadWriteCloser, error) { return nil, errors.New("no terminal") }
	f := setupLine()
	f.IsYes = false
	f.Unattended = []string{}
	f.IsNoRepositories = true

	report, err := m.init.Run(f)

	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	got, _ := config.Load(m.init.Paths.Config)
	if len(got.Folders) != 0 || got.Caps != (config.Caps{Ships: 4, Running: 2}) || !slices.Contains(m.service.calls, "install") {
		t.Errorf("configuration = %+v, service calls %v, want no folders, fresh limits and the service installed", got, m.service.calls)
	}
	if report.Said[0] != "Ready: this computer is joined to the fleet." {
		t.Errorf("said %q, want Ready first", report.Said)
	}
}

func TestSetupLineRefusesAFolderWithoutItsPath(t *testing.T) {
	machine, _, fleet := aMain(t)

	if output, code := Main(append(setupWords(), "--folder", "notes"), machine); code != 2 || len(fleet.registered) != 0 {
		t.Errorf("init = %d, %s, want the usage and no registration", code, output)
	}
}
