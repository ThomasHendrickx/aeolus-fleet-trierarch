package guard

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
)

// Tool kinds, harness-neutral (design 4.1). An MCP tool is mcp:<server>/<tool>.
const (
	kindShell     = "shell"
	kindFileWrite = "file-write"
	kindFileRead  = "file-read"
	kindWeb       = "web"
	kindAgent     = "agent"
)

// claudeCodeKinds maps Claude Code's tools onto the guard's kinds, as the
// table in docs/trierarch.md ("The guard check") lists them.
var claudeCodeKinds = map[string]string{
	"Bash":         kindShell,
	"BashOutput":   kindShell,
	"KillShell":    kindShell,
	"Write":        kindFileWrite,
	"Edit":         kindFileWrite,
	"MultiEdit":    kindFileWrite,
	"NotebookEdit": kindFileWrite,
	"Read":         kindFileRead,
	"Glob":         kindFileRead,
	"Grep":         kindFileRead,
	"LS":           kindFileRead,
	"NotebookRead": kindFileRead,
	"Skill":        kindFileRead,
	"ToolSearch":   kindFileRead,
	"SlashCommand": kindFileRead,
	"TodoWrite":    kindFileRead,
	"WebFetch":     kindWeb,
	"WebSearch":    kindWeb,
	"Task":         kindAgent,
	"Agent":        kindAgent,
}

// claudeCodeKind is the kind of a Claude Code tool, "" for a tool the guard
// does not know. Claude Code names an MCP tool mcp__<server>__<tool>.
func claudeCodeKind(tool string) string {
	if strings.HasPrefix(tool, "mcp__") {
		return mcpKind(tool)
	}
	return claudeCodeKinds[tool]
}

func mcpKind(tool string) string {
	if rest, ok := strings.CutPrefix(tool, "mcp__"); ok {
		server, name, found := strings.Cut(rest, "__")
		if !found || server == "" || name == "" {
			return ""
		}
		return "mcp:" + server + "/" + name
	}
	return ""
}

// call is one tool call as the guard reads it.
type call struct {
	tool  string
	kind  string
	input json.RawMessage
	cwd   string
	// command is the shell input of a shell call.
	command      string
	patchTargets []string
	isInternal   bool
	isAllMCP     bool
}

// hookInput is a harness's PreToolUse hook input, as far as the guard reads it.
type hookInput struct {
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
	Cwd       string          `json:"cwd"`
}

func readCall(input io.Reader, harness string) (call, error) {
	var hook hookInput
	if err := json.NewDecoder(input).Decode(&hook); err != nil {
		return call{}, fmt.Errorf("decode hook input: %w", err)
	}
	if hook.ToolName == "" {
		return call{}, errors.New("hook input names no tool")
	}
	read := call{tool: hook.ToolName, input: hook.ToolInput, cwd: hook.Cwd}
	if harness == "codex" {
		if err := read.readCodex(); err != nil {
			return call{}, err
		}
	} else {
		read.kind = claudeCodeKind(hook.ToolName)
	}
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

// fileWrites are the paths a file tool writes, made absolute from the
// session's working folder.
func (c call) fileWrites() []writeTarget {
	if c.kind != kindFileWrite {
		return nil
	}
	if len(c.patchTargets) > 0 {
		writes := make([]writeTarget, 0, len(c.patchTargets))
		for _, target := range c.patchTargets {
			writes = append(writes, c.fileWrite(target))
		}
		return writes
	}
	var input struct {
		FilePath     string `json:"file_path"`
		NotebookPath string `json:"notebook_path"`
	}
	if err := json.Unmarshal(c.input, &input); err != nil {
		return []writeTarget{{unresolvable: "write target of " + c.tool}}
	}
	target := input.FilePath
	if target == "" {
		target = input.NotebookPath
	}
	if target == "" {
		return []writeTarget{{unresolvable: "write target of " + c.tool}}
	}
	return []writeTarget{c.fileWrite(target)}
}

func (c call) fileWrite(target string) writeTarget {
	if !path.IsAbs(target) {
		if c.cwd == "" {
			return writeTarget{unresolvable: "write target " + target + " in an unknown working folder"}
		}
		target = path.Join(c.cwd, target)
	}
	return writeTarget{path: path.Clean(target)}
}
