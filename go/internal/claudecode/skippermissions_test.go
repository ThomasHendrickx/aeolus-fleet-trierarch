package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

func TestBypassPermissionsModeIsAcceptedOnlyWhereTheUserSettingsSayTrue(t *testing.T) {
	for name, text := range map[string]string{
		"accepted": `{"skipDangerousModePermissionPrompt":true}`,
		"false":    `{"skipDangerousModePermissionPrompt":false}`,
		"not true": `{"skipDangerousModePermissionPrompt":"yes"}`,
		"absent":   `{}`,
		"not JSON": `nope`,
	} {
		t.Run(name, func(t *testing.T) {
			machine := aMachineOf(t)
			machine.write(t, machine.user, text)

			if got, want := IsSkipPermissionsAccepted(machine.user), name == "accepted"; got != want {
				t.Errorf("IsSkipPermissionsAccepted(%s) = %v, want %v", text, got, want)
			}
		})
	}
}

func TestBypassPermissionsModeIsNotAcceptedWithoutUserSettings(t *testing.T) {
	machine := aMachineOf(t)

	if IsSkipPermissionsAccepted(machine.user) {
		t.Error("IsSkipPermissionsAccepted(missing file) = true, want false")
	}
}

// rewrittenByAPluginInstall is the user settings as a plugin install left them in #393: its own entries only, the acceptance gone.
const rewrittenByAPluginInstall = `{"extraKnownMarketplaces":{"aeolus-fleet":{"source":{"source":"github","repo":"ThomasHendrickx/aeolus-fleet-trierarch"}}},"enabledPlugins":{"aeolus-fleet@aeolus-fleet":true}}`

var launchesSkippingPermissions = config.Harness{Flags: []string{"--dangerously-skip-permissions"}}

// keptOnce is a keeper that saw the operator's acceptance in the user settings, which were then written as text says.
func keptOnce(t *testing.T, harness config.Harness, text string) (SkipPermissions, aMachine) {
	t.Helper()
	machine := aMachineOf(t)
	keeper := SkipPermissions{Settings: machine.user, Seen: filepath.Join(t.TempDir(), "claude-code-bypass-accepted")}
	machine.write(t, machine.user, `{"skipDangerousModePermissionPrompt":true}`)
	if !keeper.Keep(harness) {
		t.Fatal("Keep(accepted settings) = false, want true")
	}
	machine.write(t, machine.user, text)
	return keeper, machine
}

func TestBypassPermissionsModeTheOperatorAcceptedIsAcceptedAgainWhereTheSettingsLostIt(t *testing.T) {
	for name, harness := range map[string]config.Harness{
		"skip-permissions in its flags": launchesSkippingPermissions,
		"skip-permissions in an option": {Flags: []string{}, Options: map[string]config.Option{"permissions": {Values: map[string][]string{"skip": {"--dangerously-skip-permissions"}}}}},
	} {
		t.Run(name, func(t *testing.T) {
			keeper, machine := keptOnce(t, harness, rewrittenByAPluginInstall)

			if !keeper.Keep(harness) {
				t.Fatalf("Keep(%v) = false, want true", harness)
			}
			var settings map[string]any
			text, _ := os.ReadFile(machine.user)
			if err := json.Unmarshal(text, &settings); err != nil {
				t.Fatal(err)
			}
			if settings["skipDangerousModePermissionPrompt"] != true || settings["extraKnownMarketplaces"] == nil || settings["enabledPlugins"] == nil {
				t.Errorf("settings.json:\n%s\nwant the acceptance beside the marketplace and the plugin", text)
			}
		})
	}
}

func TestBypassPermissionsModeIsLeftAsTheSettingsSayWhereItIsNotKeptAgain(t *testing.T) {
	for name, at := range map[string]struct {
		harness config.Harness
		text    string
	}{
		"the flags launch without skip-permissions": {config.Harness{Flags: []string{"--model", "opus"}}, rewrittenByAPluginInstall},
		"the operator turned it off":                {launchesSkippingPermissions, `{"skipDangerousModePermissionPrompt":false}`},
		"the settings are no JSON":                  {launchesSkippingPermissions, "nope"},
	} {
		t.Run(name, func(t *testing.T) {
			keeper, machine := keptOnce(t, at.harness, at.text)

			if keeper.Keep(at.harness) {
				t.Errorf("Keep(%v) after the settings became %s = true, want false", at.harness, at.text)
			}
			if text, _ := os.ReadFile(machine.user); string(text) != at.text {
				t.Errorf("settings.json:\n%s\nwant it untouched", text)
			}
		})
	}
}

func TestBypassPermissionsModeTheOperatorNeverAcceptedIsNotAccepted(t *testing.T) {
	machine := aMachineOf(t)
	machine.write(t, machine.user, rewrittenByAPluginInstall)
	keeper := SkipPermissions{Settings: machine.user, Seen: filepath.Join(t.TempDir(), "claude-code-bypass-accepted")}

	if keeper.Keep(launchesSkippingPermissions) {
		t.Error("Keep(never accepted) = true, want false: only the operator accepts bypass permissions mode")
	}
	if text, _ := os.ReadFile(machine.user); string(text) != rewrittenByAPluginInstall {
		t.Errorf("settings.json:\n%s\nwant it untouched", text)
	}
}
