package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
)

const guardHookTimeout = 10

// ValidateGuardFlags refuses operator flags that could bypass the hook or separate the turn from its appended options.
func ValidateGuardFlags(flags []string) error {
	for _, flag := range flags {
		name, _, _ := strings.Cut(flag, "=")
		if name == "--dangerously-bypass-hook-trust" || name == "--" {
			return &guard.DisabledError{Reason: name + " is forbidden in Codex launch flags"}
		}
	}
	return nil
}

func shellQuote(word string) string {
	return "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
}

func guardCommand(program string) string {
	return shellQuote(program) + ` guard watchdog >/dev/null || { code=$?; if [ "$code" -ne 2 ]; then printf '%s\n' 'Refused by the guard: guard failed' >&2; fi; exit 2; }`
}

func guardFlags(command string) []string {
	quoted, _ := json.Marshal(command)
	return []string{"--enable", "hooks", "-c", fmt.Sprintf("hooks.PreToolUse=[{matcher=\"*\",hooks=[{type=\"command\",command=%s,timeout=%d}]}]", quoted, guardHookTimeout)}
}

// GuardWatchdog kills a guard check that has not answered within its deadline.
// Its stdout is discarded and the shell wrapper translates watchdog failure to exit 2.
func GuardWatchdog(ctx context.Context, program string, stdin io.Reader, stderr io.Writer) int {
	ctx, cancel := context.WithTimeout(ctx, guard.Deadline)
	defer cancel()
	run := exec.CommandContext(ctx, program, "guard", "check", "--harness", "codex")
	run.Stdin, run.Stderr = stdin, stderr
	run.WaitDelay = 250 * time.Millisecond
	err := run.Run()
	var exited *exec.ExitError
	switch {
	case ctx.Err() != nil:
		return 1
	case err == nil:
		return 0
	case errors.As(err, &exited) && exited.ExitCode() == 2:
		return 2
	default:
		return 1
	}
}

// GuardTurn is the context in which a Codex hold is about to start one turn.
type GuardTurn struct {
	Program     string
	Version     string
	Folder      string
	Environment []string
	Paths       paths.Paths
	ShipID      string
}

// Prepare checks the installed version and applies the same guard to every exec
// and resume while the version is proven. Only empty resolutions may run before proof.
func (t GuardTurn) Prepare(ctx context.Context, command []string) ([]string, error) {
	execProgram, err := exec.LookPath(command[0])
	if err != nil {
		return nil, fmt.Errorf("find Codex: %w", err)
	}
	proof, err := guardfile.Store{Guards: t.Paths.Guard}.Resolution(ctx, t.ShipID)
	if err != nil {
		return nil, err
	}
	entry, err := (state.File{Path: t.Paths.State}).Load()
	if err != nil {
		return nil, err
	}
	ship, ok := entry.Entries[t.ShipID]
	if !ok || ship.Harness != "codex" || proof == nil || ship.SettingsVersion != proof.SettingsVersion {
		return nil, errors.New("rules of the assignment have not arrived")
	}
	version := (Detector{Program: execProgram, Run: detection.Run}).GuardVersion(ctx, t.Paths.Detected, t.Version)
	if version == "" {
		if proof.HasSets {
			return nil, errors.New("Codex version has no proof")
		}
		return command, nil
	}
	return t.withHook(ctx, execProgram, command)
}

func (t GuardTurn) withHook(ctx context.Context, program string, command []string) ([]string, error) {
	end := slices.Index(command, "--")
	if end < 2 || len(command) != end+2 {
		return nil, errors.New("Codex turn has no prompt separator")
	}
	flags := command[2:end]
	if len(flags) >= 2 && flags[0] == "resume" {
		flags = flags[2:]
	}
	if err := ValidateGuardFlags(flags); err != nil {
		return nil, err
	}
	wrapper := guardCommand(t.Program)
	flags = append(slices.Clone(flags), guardFlags(wrapper)...)
	overrides, err := overridesOf(flags)
	if err != nil {
		return nil, err
	}
	server := AppServer{Program: program, Version: t.Version, Folder: t.Folder, Environment: t.Environment}
	if err := server.TrustGuard(ctx, overrides, wrapper); err != nil {
		return nil, err
	}
	prepared := append(slices.Clone(command[:end]), guardFlags(wrapper)...)
	prepared[0] = program
	return append(prepared, command[end:]...), nil
}

// GuardVersion returns the installed Codex version when detection proved that version with this trierarch.
func (d Detector) GuardVersion(ctx context.Context, file, trierarch string) string {
	found := (detection.File{Path: file}).Load()["codex"]
	if found.GuardProof == "" {
		return ""
	}
	version, ok := d.Version(ctx)
	if ok && guardProven(found, version, trierarch) {
		return version
	}
	return ""
}

func guardProven(found detection.Harness, version, trierarch string) bool {
	return version != "" && trierarch != "" && found.Version == version && found.GuardProof == trierarch
}
