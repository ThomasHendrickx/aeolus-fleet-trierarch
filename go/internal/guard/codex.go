package guard

import (
	"encoding/json"
	"errors"
	"strings"
)

var codexKinds = map[string]string{
	"Bash":                       kindShell,
	"apply_patch":                kindFileWrite,
	"view_image":                 kindFileRead,
	"webrun":                     kindWeb,
	"collaborationspawn_agent":   kindAgent,
	"collaborationfollowup_task": kindAgent,
	"collaborationsend_message":  kindAgent,
}

var codexInternals = map[string]bool{
	"collaborationwait_agent":      true,
	"collaborationlist_agents":     true,
	"collaborationinterrupt_agent": true,
	"create_goal":                  true,
	"update_goal":                  true,
	"get_goal":                     true,
	"update_plan":                  true,
	"clock__curr_time":             true,
}

func (c *call) readCodex() error {
	c.isInternal = codexInternals[c.tool]
	switch c.tool {
	case "apply_patch":
		var input struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal(c.input, &input); err != nil {
			return err
		}
		c.patchTargets = patchTargets(input.Command)
		if len(c.patchTargets) == 0 || c.cwd == "" {
			return errors.New("patch input does not name write paths and a working folder")
		}
	case "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource":
		var input struct {
			Server string `json:"server"`
		}
		if err := json.Unmarshal(c.input, &input); err != nil {
			return err
		}
		if input.Server != "" {
			c.kind = "mcp:" + input.Server + "/*"
			return nil
		}
		if c.tool == "read_mcp_resource" {
			return errors.New("resource read names no server")
		}
		c.isAllMCP = true
	}
	c.kind = codexKinds[c.tool]
	if c.kind == "" {
		c.kind = mcpKind(c.tool)
	}
	return nil
}

// patch reads the same write paths when apply_patch runs through a shell.
func (a *analyzer) patch(c runCall) {
	var input string
	switch {
	case len(c.args) == 0:
		if text, ok := a.literalStdin(c.input); ok {
			input = text
		}
	case len(c.args) == 1 && c.args[0].literal:
		input = c.args[0].text
	}
	targets := patchTargets(input)
	if len(targets) == 0 {
		a.out.cannotResolve("apply_patch input")
		return
	}
	patch := call{cwd: c.state.cwd}
	for _, target := range targets {
		a.out.writes = append(a.out.writes, patch.fileWrite(target))
	}
}

func patchTargets(command string) []string {
	lines := strings.Split(strings.TrimSpace(command), "\n")
	if len(lines) < 3 || strings.TrimSpace(lines[0]) != "*** Begin Patch" || strings.TrimSpace(lines[len(lines)-1]) != "*** End Patch" {
		return nil
	}
	var targets []string
	for _, line := range lines[1 : len(lines)-1] {
		for _, header := range []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "} {
			if target, found := strings.CutPrefix(strings.TrimSpace(line), header); found {
				if target == "" {
					return nil
				}
				targets = append(targets, target)
				break
			}
		}
	}
	return targets
}

// restrictsMCP reports whether a tool pattern can match an MCP tool.
func restrictsMCP(pattern string) bool {
	head, _, starred := strings.Cut(pattern, "*")
	return strings.HasPrefix(head, "mcp:") || starred && strings.HasPrefix("mcp:", head)
}

// CodexProtected names guard and trierarch files, the Codex settings and
// rules in its effective home, and any .codex folder in its workspaces.
func CodexProtected(home, guardFolder, configuration string, workspaces ...string) []string {
	protected := []string{
		guardFolder + "/**", configuration,
		home + "/config.toml", home + "/*.config.toml", home + "/hooks.json", home + "/rules/**",
	}
	for _, workspace := range workspaces {
		protected = append(protected, workspace+"/**/.codex/**")
	}
	return protected
}
