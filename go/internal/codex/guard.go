package codex

import (
	"fmt"
	"strings"
)

const guardHookTimeout = 10

// ValidateGuardFlags refuses operator flags that could bypass the hook or separate the turn from its appended options.
func ValidateGuardFlags(flags []string) error {
	for _, flag := range flags {
		name, _, _ := strings.Cut(flag, "=")
		if name == "--dangerously-bypass-hook-trust" || name == "--" {
			return fmt.Errorf("guard disabled: %s is forbidden in Codex launch flags", name)
		}
	}
	return nil
}
