package claudecode

import (
	"encoding/json"
	"os"
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

func TestBypassPermissionsModeIsAcceptedWhereTheConfigurationLaunchesWithSkipPermissions(t *testing.T) {
	for name, at := range map[string]struct {
		harness config.Harness
		text    string
	}{
		"in its flags, settings a plugin install rewrote": {launchesSkippingPermissions, rewrittenByAPluginInstall},
		"in an option, settings a plugin install rewrote": {config.Harness{Flags: []string{}, Options: map[string]config.Option{"permissions": {Values: map[string][]string{"skip": {"--dangerously-skip-permissions"}}}}}, rewrittenByAPluginInstall},
		"in its flags, settings that turn it off":         {launchesSkippingPermissions, `{"skipDangerousModePermissionPrompt":false,"extraKnownMarketplaces":{},"enabledPlugins":{}}`},
	} {
		t.Run(name, func(t *testing.T) {
			machine := aMachineOf(t)
			machine.write(t, machine.user, at.text)

			if !KeepSkipPermissionsAccepted(machine.user, at.harness) {
				t.Fatalf("KeepSkipPermissionsAccepted(%v) = false, want true", at.harness)
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

func TestBypassPermissionsModeIsAcceptedWhereTheConfigurationLaunchesWithSkipPermissionsAndThereAreNoUserSettings(t *testing.T) {
	machine := aMachineOf(t)

	if !KeepSkipPermissionsAccepted(machine.user, launchesSkippingPermissions) || !IsSkipPermissionsAccepted(machine.user) {
		t.Error("KeepSkipPermissionsAccepted(missing file) left bypass permissions mode unaccepted")
	}
}

func TestBypassPermissionsModeIsLeftAsTheSettingsSayWhereItIsNotAccepted(t *testing.T) {
	for name, at := range map[string]struct {
		harness config.Harness
		text    string
	}{
		"the flags launch without skip-permissions": {config.Harness{Flags: []string{"--model", "opus"}}, rewrittenByAPluginInstall},
		"the settings are no JSON":                  {launchesSkippingPermissions, "nope"},
	} {
		t.Run(name, func(t *testing.T) {
			machine := aMachineOf(t)
			machine.write(t, machine.user, at.text)

			if KeepSkipPermissionsAccepted(machine.user, at.harness) {
				t.Errorf("KeepSkipPermissionsAccepted(%v) with settings %s = true, want false", at.harness, at.text)
			}
			if text, _ := os.ReadFile(machine.user); string(text) != at.text {
				t.Errorf("settings.json:\n%s\nwant it untouched", text)
			}
		})
	}
}
