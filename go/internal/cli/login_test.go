package cli

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/keys"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

const aKey = "sk-ant-api03-login-test-key"

// aLoginMachine is a machine set up by init, with the key the operator types and a vendor that takes every key.
func aLoginMachine(t *testing.T) (Machine, *anInstalledService) {
	t.Helper()
	machine, installed, _ := aMain(t)
	if _, code := Main(setupWords(), machine); code != 0 {
		t.Fatal("init failed")
	}
	installed.calls = nil
	machine.ReadKey = func() (string, error) { return aKey + "\n", nil }
	machine.CheckKey = func(harness string, key string) keys.Checked { return keys.Checked{IsTaken: true} }
	machine.CheckNow = func(at paths.Paths, harness string) (keys.StateAt, bool) { return keys.StateAt{}, false }
	return machine, installed
}

func pathsOf(machine Machine) paths.Paths {
	return paths.Of(machine.HomeDirectory, "")
}

func loginsOf(t *testing.T, machine Machine) *config.Logins {
	t.Helper()
	configuration, err := config.Load(pathsOf(machine).Config)
	if err != nil {
		t.Fatal(err)
	}
	return configuration.Logins
}

func TestLoginAloneSaysEachHarnesssDefaultAndKeyAndEachShipOnItsOwnLogin(t *testing.T) {
	machine, _ := aLoginMachine(t)
	Main([]string{"login", "--ship", "scout", "api-key"}, machine)
	if err := (keys.Files{Folder: pathsOf(machine).Keys}).Write("claude-code", aKey); err != nil {
		t.Fatal(err)
	}

	output, code := Main([]string{"login"}, machine)

	want := strings.Join([]string{
		"Claude Code  default Subscription  API key ready",
		"Codex        default Subscription  no API key",
		"scout        API key",
	}, "\n")
	if code != 0 || output != want {
		t.Fatalf("login answered %d:\n%s\nwant:\n%s", code, output, want)
	}
	if strings.Contains(output, aKey) {
		t.Fatal("login says the key")
	}
}

func TestLoginAnswersItsReportAsJSON(t *testing.T) {
	machine, _ := aLoginMachine(t)

	output, code := Main([]string{"login", "--json"}, machine)

	want := []any{map[string]any{"harness": "claude-code", "default": "subscription", "key": "none"}, map[string]any{"harness": "codex", "default": "subscription", "key": "none"}}
	if got := decoded(t, output)["harnesses"]; code != 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("login --json harnesses = %v, %d, want %v", got, code, want)
	}
}

func TestADefaultLoginIsWrittenToTheConfigurationAndTheServiceRestarts(t *testing.T) {
	machine, installed := aLoginMachine(t)

	output, code := Main([]string{"login", "claude-code", "--default", "api-key"}, machine)

	if code != 0 || output != "Claude Code runs on API key by default, from each session's next start.\nThe trierarch restarted; its sessions kept running." {
		t.Fatalf("answered %d: %q", code, output)
	}
	if logins := loginsOf(t, machine); logins == nil || logins.Default == nil || logins.Default.ClaudeCode != "apiKey" {
		t.Fatalf("logins %+v, want claude-code on apiKey by default", logins)
	}
	if !slices.Equal(installed.calls, []string{"restart"}) {
		t.Fatalf("service calls %q, want a restart", installed.calls)
	}
}

func TestADefaultItHasAlreadyChangesNothing(t *testing.T) {
	machine, installed := aLoginMachine(t)
	Main([]string{"login", "claude-code", "--default", "api-key"}, machine)
	installed.calls = nil

	output, code := Main([]string{"login", "claude-code", "--default", "api-key"}, machine)

	if code != 0 || output != "Claude Code runs on API key by default already." || len(installed.calls) != 0 {
		t.Fatalf("answered %d: %q, service calls %q", code, output, installed.calls)
	}
}

func TestAShipsOwnLoginIsSetAndClearedAgain(t *testing.T) {
	machine, _ := aLoginMachine(t)

	if output, code := Main([]string{"login", "--ship", "scout", "subscription"}, machine); code != 0 || !strings.HasPrefix(output, "scout runs on Subscription from its next start.") {
		t.Fatalf("answered %d: %q", code, output)
	}
	if logins := loginsOf(t, machine); logins == nil || logins.Ships["scout"] != "subscription" {
		t.Fatalf("logins %+v, want scout on subscription", logins)
	}
	if output, code := Main([]string{"login", "--ship", "scout", "default"}, machine); code != 0 || !strings.HasPrefix(output, "scout runs on its harness's default from its next start.") {
		t.Fatalf("answered %d: %q", code, output)
	}
	if logins := loginsOf(t, machine); logins != nil && len(logins.Ships) != 0 {
		t.Fatalf("logins %+v, want no ship of its own", logins)
	}
}

func TestAKeyTheVendorTakesIsKeptForItsUserAloneAndTheServiceRestarts(t *testing.T) {
	machine, installed := aLoginMachine(t)
	checked := []string{}
	machine.CheckKey = func(harness string, key string) keys.Checked {
		checked = append(checked, harness+" "+key)
		return keys.Checked{IsTaken: true}
	}

	output, code := Main([]string{"login", "claude-code", "--api-key"}, machine)

	if code != 0 || output != "The vendor took the API key for Claude Code; it is kept on this computer only.\nThe trierarch restarted; its sessions kept running." {
		t.Fatalf("answered %d: %q", code, output)
	}
	if !slices.Equal(checked, []string{"claude-code " + aKey}) {
		t.Fatalf("checked %q, want the key without its line end", checked)
	}
	file := filepath.Join(pathsOf(machine).Keys, "claude-code")
	if info, err := os.Stat(file); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the key file %s: %v, %v", file, info, err)
	}
	if !slices.Equal(installed.calls, []string{"restart"}) {
		t.Fatalf("service calls %q", installed.calls)
	}
}

func TestAKeyTheVendorRefusesIsNotWrittenAndTheCauseNamesNoKey(t *testing.T) {
	machine, installed := aLoginMachine(t)
	machine.CheckKey = func(string, string) keys.Checked {
		return keys.Checked{Cause: "Anthropic refused the key: 401 authentication_error"}
	}

	output, code := Main([]string{"login", "claude-code", "--api-key"}, machine)

	if code != 1 || output != "Anthropic refused the key: 401 authentication_error: nothing was written" || len(installed.calls) != 0 {
		t.Fatalf("answered %d: %q, service calls %q", code, output, installed.calls)
	}
	if (keys.Files{Folder: pathsOf(machine).Keys}).Has("claude-code") {
		t.Fatal("a refused key was written")
	}
}

func TestNoKeyComingInIsRefused(t *testing.T) {
	machine, _ := aLoginMachine(t)
	machine.ReadKey = func() (string, error) { return " \n", nil }

	output, code := Main([]string{"login", "claude-code", "--api-key"}, machine)

	if code != 1 || output != "no API key came in: pipe it in, or type it when asked" {
		t.Fatalf("answered %d: %q", code, output)
	}
}

func TestAKeyIsRemovedAndTheServiceRestartsOnlyWhenThereWasOne(t *testing.T) {
	machine, installed := aLoginMachine(t)
	if output, code := Main([]string{"login", "codex", "--remove-key"}, machine); code != 0 || output != "Codex holds no API key: nothing to remove." || len(installed.calls) != 0 {
		t.Fatalf("answered %d: %q, service calls %q", code, output, installed.calls)
	}
	Main([]string{"login", "codex", "--api-key"}, machine)
	installed.calls = nil

	output, code := Main([]string{"login", "codex", "--remove-key"}, machine)

	if code != 0 || !strings.HasPrefix(output, "Removed the API key for Codex.") || !slices.Equal(installed.calls, []string{"restart"}) {
		t.Fatalf("answered %d: %q, service calls %q", code, output, installed.calls)
	}
}

func TestACheckSaysWhatTheProxyFoundOfTheKey(t *testing.T) {
	machine, _ := aLoginMachine(t)
	cases := []struct {
		state keys.StateAt
		want  string
	}{
		{keys.StateAt{State: keys.Ready}, "Claude Code's API key is ready: its waiting ships start within a pass."},
		{keys.StateAt{State: keys.OutOfCredit, At: "2026-11-02T09:00:00.000Z"}, "Claude Code's API key is still out of credit since 2026-11-02T09:00:00.000Z. The proxy checks it again every 15 minutes."},
		{keys.StateAt{State: keys.Refused}, "Claude Code's API key was refused by its vendor: give it a new one with aeolus-trierarch login claude-code --api-key."},
		{keys.StateAt{State: keys.None}, "Claude Code holds no API key: aeolus-trierarch login claude-code --api-key."},
	}
	for _, each := range cases {
		machine.CheckNow = func(paths.Paths, string) (keys.StateAt, bool) { return each.state, true }

		if output, code := Main([]string{"login", "claude-code", "--check"}, machine); code != 0 || output != each.want {
			t.Errorf("check of %+v answered %d: %q, want %q", each.state, code, output, each.want)
		}
	}
}

func TestACheckWithNoProxyRunningIsRefused(t *testing.T) {
	machine, _ := aLoginMachine(t)

	output, code := Main([]string{"login", "claude-code", "--check"}, machine)

	if code != 1 || !strings.HasPrefix(output, "the model proxy does not run") {
		t.Fatalf("answered %d: %q", code, output)
	}
}

func TestLoginRefusesCopilotAndWhatItCannotTake(t *testing.T) {
	machine, _ := aLoginMachine(t)
	cases := []struct {
		words []string
		want  string
	}{
		{[]string{"login", "copilot", "--api-key"}, "copilot signs in with this computer's own login"},
		{[]string{"login", "cursor", "--api-key"}, "login takes claude-code or codex"},
		{[]string{"login", "claude-code"}, "login takes claude-code or codex"},
		{[]string{"login", "claude-code", "--api-key", "--check"}, "login takes claude-code or codex"},
		{[]string{"login", "claude-code", "--default", "default"}, "a login is api-key or subscription"},
		{[]string{"login", "--ship", "scout", "bedrock"}, "a ship's login is api-key, subscription or default"},
	}
	for _, each := range cases {
		if output, code := Main(each.words, machine); code != 1 || !strings.HasPrefix(output, each.want) {
			t.Errorf("%q answered %d: %q, want %q", each.words, code, output, each.want)
		}
	}
}
