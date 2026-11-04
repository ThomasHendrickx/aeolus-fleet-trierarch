package claudecode

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// aMachine is Claude Code's settings as a session on its subscription would read them: managed settings, the user's, and a folder it starts in.
type aMachine struct {
	managed, user, folder string
}

func aMachineOf(t *testing.T) aMachine {
	t.Helper()
	root := t.TempDir()
	return aMachine{managed: filepath.Join(root, "managed"), user: filepath.Join(root, "home", ".claude", "settings.json"), folder: filepath.Join(root, "worktree")}
}

func (m aMachine) write(t *testing.T, path string, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (m aMachine) subscription(settings config.Harness) Subscription {
	return Subscription{Settings: settings, Managed: m.managed, User: m.user}
}

// reached is the cause a session that would reach the key found gets.
func reached(found string) string {
	return "claude-code would reach an API key on its subscription (" + found + "): remove it, or run the ship on its API key"
}

func TestASessionOnItsSubscriptionWithNoKeyInReachHasNoProblem(t *testing.T) {
	machine := aMachineOf(t)
	machine.write(t, machine.user, `{"skipDangerousModePermissionPrompt":true,"env":{"ANTHROPIC_MODEL":"opus"}}`)

	if got := machine.subscription(config.Harness{}).Problem(nil, machine.folder); got != "" {
		t.Fatalf("Problem = %q, want none", got)
	}
}

func TestEachKeyInTheUsersSettingsIsNamedWithItsFileNeverItsValue(t *testing.T) {
	cases := []struct{ settings, found string }{
		{`{"apiKeyHelper":"/bin/print-key"}`, "apiKeyHelper"},
		{`{"env":{"ANTHROPIC_API_KEY":"sk-ant-secret"}}`, "ANTHROPIC_API_KEY"},
		{`{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-ant-secret"}}`, "ANTHROPIC_AUTH_TOKEN"},
		{`{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}`, "CLAUDE_CODE_USE_BEDROCK"},
		{`{"env":{"CLAUDE_CODE_USE_VERTEX":"1"}}`, "CLAUDE_CODE_USE_VERTEX"},
		{`{"env":{"CLAUDE_CODE_USE_FOUNDRY":"1"}}`, "CLAUDE_CODE_USE_FOUNDRY"},
	}
	for _, each := range cases {
		t.Run(each.found, func(t *testing.T) {
			machine := aMachineOf(t)
			machine.write(t, machine.user, each.settings)

			if got, want := machine.subscription(config.Harness{}).Problem(nil, machine.folder), reached(each.found+" in "+machine.user); got != want {
				t.Fatalf("Problem with %s = %q, want %q", each.settings, got, want)
			}
		})
	}
}

func TestAnEmptyOrBrokenSettingPutsNoKeyInReach(t *testing.T) {
	cases := []string{`{"apiKeyHelper":""}`, `{"env":{"ANTHROPIC_API_KEY":""}}`, `{"apiKeyHelper":true}`, `not json`, `["apiKeyHelper"]`}
	for _, settings := range cases {
		machine := aMachineOf(t)
		machine.write(t, machine.user, settings)

		if got := machine.subscription(config.Harness{}).Problem(nil, machine.folder); got != "" {
			t.Errorf("Problem with %s = %q, want none", settings, got)
		}
	}
}

func TestTheFoldersLocalAndProjectSettingsAreReadInTheFolderItStartsIn(t *testing.T) {
	for _, file := range []string{"settings.local.json", "settings.json"} {
		t.Run(file, func(t *testing.T) {
			machine := aMachineOf(t)
			path := filepath.Join(machine.folder, ".claude", file)
			machine.write(t, path, `{"apiKeyHelper":"/bin/print-key"}`)

			if got, want := machine.subscription(config.Harness{}).Problem(nil, machine.folder), reached("apiKeyHelper in "+path); got != want {
				t.Fatalf("Problem = %q, want %q", got, want)
			}
		})
	}
}

func TestTheManagedSettingsAndTheirVisibleDropInsAreRead(t *testing.T) {
	machine := aMachineOf(t)
	dropIn := filepath.Join(machine.managed, "managed-settings.d", "10-cloud.json")
	machine.write(t, filepath.Join(machine.managed, "managed-settings.d", ".00-hidden.json"), `{"apiKeyHelper":"/bin/print-key"}`)
	machine.write(t, filepath.Join(machine.managed, "managed-settings.d", "05-notes.txt"), `{"apiKeyHelper":"/bin/print-key"}`)
	machine.write(t, dropIn, `{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}`)

	if got, want := machine.subscription(config.Harness{}).Problem(nil, machine.folder), reached("CLAUDE_CODE_USE_BEDROCK in "+dropIn); got != want {
		t.Fatalf("Problem = %q, want %q", got, want)
	}
}

func TestTheManagedSettingsFileComesBeforeTheUsers(t *testing.T) {
	machine := aMachineOf(t)
	managed := filepath.Join(machine.managed, "managed-settings.json")
	machine.write(t, managed, `{"apiKeyHelper":"/bin/print-key"}`)
	machine.write(t, machine.user, `{"env":{"ANTHROPIC_API_KEY":"sk-ant-secret"}}`)

	if got, want := machine.subscription(config.Harness{}).Problem(nil, machine.folder), reached("apiKeyHelper in "+managed); got != want {
		t.Fatalf("Problem = %q, want %q", got, want)
	}
}

func TestSettingsOnTheCommandLineAreRead(t *testing.T) {
	machine := aMachineOf(t)
	absolute := filepath.Join(t.TempDir(), "extra.json")
	machine.write(t, absolute, `{"apiKeyHelper":"/bin/print-key"}`)
	machine.write(t, filepath.Join(machine.folder, "relative.json"), `{"env":{"ANTHROPIC_AUTH_TOKEN":"sk"}}`)
	cases := []struct {
		name  string
		flags []string
		want  string
	}{
		{"JSON", []string{"--settings", `{"env":{"ANTHROPIC_API_KEY":"sk"}}`}, "ANTHROPIC_API_KEY in --settings"},
		{"an absolute file", []string{"--settings=" + absolute}, "apiKeyHelper in " + absolute},
		{"a file in the folder", []string{"--settings", "relative.json"}, "ANTHROPIC_AUTH_TOKEN in " + filepath.Join(machine.folder, "relative.json")},
	}
	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			if got, want := machine.subscription(config.Harness{Flags: each.flags}).Problem(nil, machine.folder), reached(each.want); got != want {
				t.Fatalf("Problem with %q = %q, want %q", each.flags, got, want)
			}
		})
	}
}

func TestAPickedOptionsFlagsAreTheSessionsOwn(t *testing.T) {
	machine := aMachineOf(t)
	settings := config.Harness{Options: map[string]config.Option{"login": {Values: map[string][]string{"plain": nil, "helper": {"--settings", `{"apiKeyHelper":"/bin/print-key"}`}}, Default: "plain"}}}

	if got := machine.subscription(settings).Problem(nil, machine.folder); got != "" {
		t.Fatalf("Problem with the default picked = %q, want none", got)
	}
	if got, want := machine.subscription(settings).Problem(map[string]string{"login": "helper"}, machine.folder), reached("apiKeyHelper in --settings"); got != want {
		t.Fatalf("Problem with helper picked = %q, want %q", got, want)
	}
}

func TestOnlyTheSourcesTheFlagsLoadAreRead(t *testing.T) {
	machine := aMachineOf(t)
	machine.write(t, machine.user, `{"apiKeyHelper":"/bin/print-key"}`)
	project := filepath.Join(machine.folder, ".claude", "settings.json")
	machine.write(t, project, `{"env":{"ANTHROPIC_API_KEY":"sk"}}`)
	cases := []struct {
		flags []string
		want  string
	}{
		{[]string{"--setting-sources", "project"}, reached("ANTHROPIC_API_KEY in " + project)},
		{[]string{"--setting-sources=local"}, ""},
		{[]string{"--setting-sources", "local, user"}, reached("apiKeyHelper in " + machine.user)},
		{[]string{"--restricted"}, ""},
	}
	for _, each := range cases {
		if got := machine.subscription(config.Harness{Flags: each.flags}).Problem(nil, machine.folder); got != each.want {
			t.Errorf("Problem with %q = %q, want %q", each.flags, got, each.want)
		}
	}
}
