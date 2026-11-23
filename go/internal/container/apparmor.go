package container

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PastaAppArmor reads the host's AppArmor configuration without changing it.
// The root and operating system let the adapter be exercised against a stand-in machine.
func (Machine) PastaAppArmor(osName string, root string) (bool, error) {
	if osName != "linux" {
		return false, nil
	}
	enabled, err := os.ReadFile(filepath.Join(root, "sys/module/apparmor/parameters/enabled"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read AppArmor status: %w", err)
	}
	if strings.TrimSpace(string(enabled)) != "Y" {
		return false, nil
	}
	profile, err := os.ReadFile(filepath.Join(root, "etc/apparmor.d/usr.bin.pasta"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read pasta AppArmor profile: %w", err)
	}
	for _, line := range strings.Split(string(profile), "\n") {
		line, _, _ = strings.Cut(line, "#")
		if strings.TrimSpace(line) == "signal (receive) set=(term) peer=podman," {
			return false, nil
		}
	}
	return true, nil
}
