package container

import (
	"os"
	"path/filepath"
	"testing"
)

// The machine adapter reads a stand-in root so this test never changes the host.
func TestPastaAppArmorFindingOnlyWhenTheActiveProfileLacksTheRule(t *testing.T) {
	checker, ok := any(Machine{}).(interface {
		PastaAppArmor(string, string) (bool, error)
	})
	if !ok {
		t.Fatal("machine does not check the pasta AppArmor profile")
	}
	for _, test := range []struct {
		name, osName, enabled, profile string
		hasProfile, want               bool
	}{
		{"missing rule", "linux", "Y\n", "profile pasta {\n}\n", true, true},
		{"rule present", "linux", "Y\n", "profile pasta {\n  signal (receive) set=(term) peer=podman,\n}\n", true, false},
		{"comment is not a rule", "linux", "Y\n", "profile pasta {\n # signal (receive) set=(term) peer=podman,\n}\n", true, true},
		{"apparmor inactive", "linux", "N\n", "profile pasta {}", true, false},
		{"no profile", "linux", "Y\n", "", false, false},
		{"not linux", "darwin", "Y\n", "profile pasta {}", true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			enabled := filepath.Join(root, "sys/module/apparmor/parameters/enabled")
			if err := os.MkdirAll(filepath.Dir(enabled), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(enabled, []byte(test.enabled), 0644); err != nil {
				t.Fatal(err)
			}
			if test.hasProfile {
				profile := filepath.Join(root, "etc/apparmor.d/usr.bin.pasta")
				if err := os.MkdirAll(filepath.Dir(profile), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(profile, []byte(test.profile), 0644); err != nil {
					t.Fatal(err)
				}
			}
			got, err := checker.PastaAppArmor(test.osName, root)
			if err != nil || got != test.want {
				t.Fatalf("finding = %v, %v; want %v", got, err, test.want)
			}
		})
	}
}
