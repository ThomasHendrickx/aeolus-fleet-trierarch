package detection

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"time"
)

// Command is a program detection runs: its arguments, the folder it runs from, empty for the trierarch's own, and the longest it may take.
type Command struct {
	Program string
	Args    []string
	Dir     string
	Timeout time.Duration
}

// Ran is what a command answered: its exit status, -1 when it could not run or was ended, and what it wrote.
type Ran struct {
	Status int
	Stdout string
	Stderr string
}

// Runner runs a command for a detector.
type Runner func(ctx context.Context, command Command) Ran

// Run runs the command with the trierarch's environment, ended once its time is up, so a CLI that hangs never holds up the trierarch for long.
func Run(ctx context.Context, command Command) Ran {
	ctx, cancel := context.WithTimeout(ctx, command.Timeout)
	defer cancel()
	run := exec.CommandContext(ctx, command.Program, command.Args...)
	run.Dir = command.Dir
	// Its output is read until the program ends, never until a child it left behind does.
	run.WaitDelay = time.Second
	var stdout, stderr bytes.Buffer
	run.Stdout, run.Stderr = &stdout, &stderr
	err := run.Run()
	status := 0
	var exited *exec.ExitError
	switch {
	case ctx.Err() != nil:
		status = -1
	case errors.As(err, &exited):
		status = exited.ExitCode()
	case err != nil:
		status = -1
	}
	return Ran{Status: status, Stdout: stdout.String(), Stderr: stderr.String()}
}

// NeutralFolder is a new empty folder to probe from: no project's hooks, settings or identity apply, so a probe is never a ship.
func NeutralFolder() (string, error) {
	return os.MkdirTemp("", "aeolus-trierarch-probe-")
}

// namePattern is a name as the configuration takes one: lowercase letters, digits, dots, hyphens and underscores, and never a path.
var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

// nameMaxLength is the longest name the configuration takes.
const nameMaxLength = 100

// IsName is whether the text is a name an option or its value may have.
func IsName(text string) bool {
	return len(text) <= nameMaxLength && namePattern.MatchString(text)
}
