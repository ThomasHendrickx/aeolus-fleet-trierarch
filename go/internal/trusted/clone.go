package trusted

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"
)

// cloneProtocols are the protocols a clone of a trusted repository may use, as git's GIT_ALLOW_PROTOCOL lists them.
const cloneProtocols = "https:ssh"

// cloneTimeout is how long a clone may take before it is ended and the crew fails.
const cloneTimeout = 10 * time.Minute

// Clones is where the trusted repositories are cloned, and the URL of each that is on the list now.
type Clones struct {
	Root string
	// URLOf is the URL of a repository on the list now, empty when it is not on it or the machine configures it.
	URLOf func(repository string) string
	// Environ is the environment a clone runs in; the process's when nil.
	Environ []string
	// Timeout is how long a clone may take; ten minutes when zero.
	Timeout time.Duration
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// cloneEnvironment is the environment of a clone: https and ssh only, no question asked of nobody, and ssh in batch mode unless the operator set its command.
func cloneEnvironment(environ []string) []string {
	kept := slices.DeleteFunc(slices.Clone(environ), func(entry string) bool {
		return strings.HasPrefix(entry, "GIT_ALLOW_PROTOCOL=") || strings.HasPrefix(entry, "GIT_TERMINAL_PROMPT=")
	})
	kept = append(kept, "GIT_ALLOW_PROTOCOL="+cloneProtocols, "GIT_TERMINAL_PROMPT=0")
	if !slices.ContainsFunc(environ, func(entry string) bool { return strings.HasPrefix(entry, "GIT_SSH_COMMAND=") }) {
		kept = append(kept, "GIT_SSH_COMMAND=ssh -o BatchMode=yes")
	}
	return kept
}

// WhenMissing clones the repository into its path when it is on the list and the machine does not have it yet, once, with the machine's own access only, into a partial folder renamed into place whole, so a stop mid-clone leaves no half clone to crew from.
func (c Clones) WhenMissing(repository string, path string) error {
	url := ""
	if c.URLOf != nil {
		url = c.URLOf(repository)
	}
	if url == "" || exists(path) {
		return nil
	}
	partial := path + ".partial"
	if err := os.RemoveAll(partial); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	timeout := c.Timeout
	if timeout == 0 {
		timeout = cloneTimeout
	}
	ctx, done := context.WithTimeout(context.Background(), timeout)
	defer done()
	command := exec.CommandContext(ctx, "git", "clone", "--quiet", "--", url, partial)
	environ := c.Environ
	if environ == nil {
		environ = os.Environ()
	}
	command.Env = cloneEnvironment(environ)
	// A clone past its time ends with the ssh it started, which would hold git's output open.
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error { return syscall.Kill(-command.Process.Pid, syscall.SIGKILL) }
	output, err := command.CombinedOutput()
	if err != nil {
		_ = os.RemoveAll(partial)
		reason := strings.TrimSpace(string(output))
		var exited *exec.ExitError
		switch {
		case ctx.Err() != nil:
			reason = "timed out"
		case reason == "" && errors.As(err, &exited):
			reason = fmt.Sprintf("exit %d", exited.ExitCode())
		case reason == "":
			reason = err.Error()
		}
		return fmt.Errorf("git clone of %s failed: %s", repository, reason)
	}
	return os.Rename(partial, path)
}

// ClonedPath is the clone of a repository that left the trusted repositories, which still holds the workspaces made from it; none when there is none.
func (c Clones) ClonedPath(repository string) (string, bool) {
	cloned := filepath.Join(c.Root, repository)
	return cloned, exists(cloned)
}
