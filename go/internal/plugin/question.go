package plugin

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Question is the permission question passed to the plugin's ask script.
type Question struct{ Title, Context, Rule, Model string }

var questionID = regexp.MustCompile(`question ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`)

// AskQuestion asks through the plugin, with context on stdin rather than argv.
func (p Plugin) AskQuestion(ctx context.Context, folder string, q Question) (string, error) {
	text, err := p.permissionScript(ctx, folder, "aeolus-ask.sh", q.Context, "ask", "--title", q.Title, "--context-stdin", "--option", "Allow once", "Allow this action once.", "--option", "Allow for this session", "Allow the session rule: "+q.Rule, "--option", "Deny", "Refuse this action.", "--pick", "3", "nothing runs without your yes", "--model", q.Model)
	match := questionID.FindStringSubmatch(text)
	if len(match) != 2 {
		if err != nil {
			return "", err
		}
		return "", errors.New("permission question script returned no question id")
	}
	return match[1], err
}

// WithdrawQuestion withdraws through the plugin, which remembers the recipient.
func (p Plugin) WithdrawQuestion(ctx context.Context, folder, id, model string) error {
	_, err := p.permissionScript(ctx, folder, "aeolus-ask.sh", "", "withdraw", id, "--model", model)
	return err
}

// PermissionContext reads the current handed task through the plugin only.
func (p Plugin) PermissionContext(ctx context.Context, folder string) (string, error) {
	return p.permissionScript(ctx, folder, "aeolus-push.sh", "", "permission-context")
}

func (p Plugin) permissionScript(ctx context.Context, folder, script, input string, args ...string) (string, error) {
	p, err := p.resolve()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "bash", append([]string{filepath.Join(p.Root, "scripts", script)}, args...)...)
	command.Dir = folder
	command.Env = append(os.Environ(), "AEOLUS_FOLDER="+folder, "AEOLUS_DATA="+p.Data, "AEOLUS_CREWS="+p.Crews, "AEOLUS_HARNESS=claude-code")
	command.Stdin = strings.NewReader(input)
	command.WaitDelay = time.Second
	out, err := command.Output()
	if err != nil {
		return string(out), errors.New("permission plugin script failed: " + script)
	}
	return string(out), nil
}
