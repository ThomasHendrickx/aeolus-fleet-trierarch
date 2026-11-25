package main

import (
	"bytes"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/cli"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
)

// guardExitMargin is how long before guard check's deadline its process answers on its own: the time its answer has to be written,
// so the process exits by the deadline whatever it waits on.
const guardExitMargin = 300 * time.Millisecond

// hookExit ends the guard check process once, with the first answer, the check's or the deadline's. The answer is written aside, so a
// write that never ends holds the process no longer than the margin.
type hookExit struct{ once sync.Once }

func (e *hookExit) exit(stdout string, stderr string, code int) {
	e.once.Do(func() {
		written := make(chan struct{})
		go func() {
			if stdout != "" {
				_, _ = fmt.Fprintln(os.Stdout, stdout)
			}
			_, _ = os.Stderr.WriteString(stderr)
			close(written)
		}()
		select {
		case <-written:
		case <-time.After(guardExitMargin):
		}
		os.Exit(code)
	})
}

// guardCheckMain runs guard check as its process's whole work and exits: its deadline starts with it, and at the deadline the process
// refuses the call and exits, whatever the check still waits on.
func guardCheckMain(args []string) {
	var ended hookExit
	deadline := guard.Failed("deadline")
	if cli.IsCodexGuardCheck(args) {
		deadline.Stdout = ""
	}
	time.AfterFunc(guard.Deadline-guardExitMargin, func() { ended.exit(deadline.Stdout, deadline.Stderr, deadline.ExitCode) })
	// A home that is not known leaves guard check no state to read: it refuses the call.
	home, _ := os.UserHomeDir()
	var stderr bytes.Buffer
	output, code := cli.Main(args, cli.Machine{Environ: os.Environ(), HomeDirectory: home, Stdin: os.Stdin, Stderr: &stderr})
	ended.exit(output, stderr.String(), code)
}
