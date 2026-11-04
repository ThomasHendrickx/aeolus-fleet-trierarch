package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/prompt"
)

// A session of Claude Code (docs/architecture.md, "First adapters"): one
// long-lived `claude -p` taking user messages as stream-json lines on stdin,
// always without AskUserQuestion and plan mode, so it asks its questions over
// the fleet and no question form blocks a wake (#457, #460); a configured
// plan mode is left out (#465); `--continue` on a restart when Claude Code
// keeps a conversation for the folder (#381). The prompt is no word of it: it
// is the first line on stdin.

// headless is print mode, taking and giving stream-json.
var headless = []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"}

const noPanePrompts = "--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode"

const wakeCommand = "/aeolus-fleet:wake"

// CommandLine is `claude` with the flags given, plan mode left out, continuing the folder's conversation when told.
func CommandLine(flags []string, isContinued bool) []string {
	command := append([]string{"claude"}, headless...)
	for at := 0; at < len(flags); at++ {
		if flags[at] == "--permission-mode=plan" {
			continue
		}
		if flags[at] == "--permission-mode" && at+1 < len(flags) && flags[at+1] == "plan" {
			at++
			continue
		}
		command = append(command, flags[at])
	}
	command = append(command, noPanePrompts)
	if isContinued {
		command = append(command, "--continue")
	}
	return command
}

var notLetterOrDigit = regexp.MustCompile(`[^a-zA-Z0-9]`)

// HasConversation says whether Claude Code keeps a conversation for the folder in its projects folder: without one, `claude --continue` exits at once.
func HasConversation(projects string, folder string) bool {
	files, err := os.ReadDir(filepath.Join(projects, notLetterOrDigit.ReplaceAllString(folder, "-")))
	if err != nil {
		return false
	}
	return slices.ContainsFunc(files, func(file os.DirEntry) bool { return strings.HasSuffix(file.Name(), ".jsonl") })
}

// Projects is Claude Code's projects folder, in CLAUDE_CONFIG_DIR or ~/.claude.
func Projects(homeDirectory string, configDirectory string) string {
	if configDirectory != "" {
		return filepath.Join(configDirectory, "projects")
	}
	return filepath.Join(homeDirectory, ".claude", "projects")
}

// UserLine is a prompt as headless Claude Code takes it on stdin: one stream-json user message on one line.
func UserLine(prompt string) string {
	type message struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	var line strings.Builder
	encoder := json.NewEncoder(&line)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(struct {
		Type    string  `json:"type"`
		Message message `json:"message"`
	}{Type: "user", Message: message{Role: "user", Content: prompt}})
	return strings.TrimSuffix(line.String(), "\n")
}

// WakePrompt is the prompt of every start but a first one with its own: the wake command, with the line that no human reads.
func WakePrompt() string {
	return prompt.Wake(wakeCommand)
}
