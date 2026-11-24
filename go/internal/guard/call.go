package guard

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Tool kinds, harness-neutral (design 4.1). An MCP tool is mcp:<server>/<tool>.
const (
	kindShell     = "shell"
	kindFileWrite = "file-write"
	kindFileRead  = "file-read"
	kindWeb       = "web"
	kindAgent     = "agent"
)

// claudeCodeKinds maps Claude Code's tools onto the guard's kinds.
var claudeCodeKinds = map[string]string{
	"Bash":     kindShell,
	"Read":     kindFileRead,
	"WebFetch": kindWeb,
}

// call is one tool call as the guard reads it.
type call struct {
	tool  string
	kind  string
	input json.RawMessage
	cwd   string
	// command is the shell input of a shell call.
	command string
}

// hookInput is Claude Code's PreToolUse hook input, as far as the guard reads it.
type hookInput struct {
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
	Cwd       string          `json:"cwd"`
}

func readCall(input io.Reader) (call, error) {
	var hook hookInput
	if err := json.NewDecoder(input).Decode(&hook); err != nil {
		return call{}, fmt.Errorf("decode hook input: %w", err)
	}
	if hook.ToolName == "" {
		return call{}, errors.New("hook input names no tool")
	}
	read := call{tool: hook.ToolName, kind: claudeCodeKinds[hook.ToolName], input: hook.ToolInput, cwd: hook.Cwd}
	if read.kind == kindShell {
		var shell struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal(hook.ToolInput, &shell); err != nil {
			return call{}, fmt.Errorf("decode shell input: %w", err)
		}
		read.command = shell.Command
	}
	return read, nil
}

// summary is the call as a refusal record shows it.
func (c call) summary() string {
	if c.kind == kindShell {
		return c.command
	}
	return string(c.input)
}
