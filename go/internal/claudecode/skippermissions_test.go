package claudecode

import "testing"

func TestBypassPermissionsModeIsAcceptedOnlyWhereTheUserSettingsSayTrue(t *testing.T) {
	for name, text := range map[string]string{
		"accepted":  `{"skipDangerousModePermissionPrompt":true}`,
		"false":     `{"skipDangerousModePermissionPrompt":false}`,
		"not true":  `{"skipDangerousModePermissionPrompt":"yes"}`,
		"absent":    `{}`,
		"not JSON":  `nope`,
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
