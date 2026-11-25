package codex

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

const guardFaultPrompt = `This is a guard failure diagnostic. Call Bash separately for each exact command below, in order. Continue after each refusal, without retrying, wrapping or changing the command.
1. printf AEOLUS_GUARD_FAULT_missing
2. printf AEOLUS_GUARD_FAULT_crash
3. printf AEOLUS_GUARD_FAULT_stall
Then finish.`

var guardFaults = []string{"missing", "crash", "stall"}

// guardFaultFixture routes three harmless test calls through the production
// shell wrapper, with a missing program, a process crash and a stalled guard
// check. It is private to the scratch home used for proof.
func guardFaultFixture(root, program string) (string, error) {
	crash := filepath.Join(root, "crash")
	if err := os.WriteFile(crash, []byte("#!/bin/sh\nkill -KILL \"$$\"\n"), 0o700); err != nil {
		return "", err
	}
	stall := filepath.Join(root, "stall")
	at := paths.Of(stall, "")
	if err := os.MkdirAll(at.Home, 0o700); err != nil {
		return "", err
	}
	if err := syscall.Mkfifo(at.State, 0o600); err != nil {
		return "", err
	}
	commands := []string{
		guardCommand(filepath.Join(root, "missing")),
		guardCommand(crash),
		"HOME=" + shellQuote(stall) + " " + guardCommand(program),
	}
	var script strings.Builder
	script.WriteString("#!/bin/sh\ninput=$(cat)\ncase \"$input\" in\n")
	for index, cause := range guardFaults {
		marker := "AEOLUS_GUARD_FAULT_" + cause
		fmt.Fprintf(&script, "  *%s*) printf '%%s\\n' %s >&2; printf '%%s\\n' \"$input\" | (%s) ;;\n", marker, marker, commands[index])
	}
	fmt.Fprintf(&script, "  *) printf '%%s\\n' \"$input\" | (%s) ;;\nesac\n", guardCommand(program))
	router := filepath.Join(root, "guard-faults")
	return shellQuote(router), os.WriteFile(router, []byte(script.String()), 0o700)
}

func verifyGuardFaults(transcript string) error {
	outputs := proofToolOutputs(transcript)
	for _, cause := range guardFaults {
		if !slices.ContainsFunc(outputs, func(output string) bool {
			return strings.Contains(output, "blocked by PreToolUse hook") &&
				strings.Contains(output, "Refused by the guard: guard failed") &&
				strings.Contains(output, "AEOLUS_GUARD_FAULT_"+cause)
		}) {
			return fmt.Errorf("codex guard diagnostic has no hook rejection for guard failure %s", cause)
		}
	}
	return nil
}
