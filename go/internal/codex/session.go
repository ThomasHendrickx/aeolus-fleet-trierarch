package codex

import (
	"bufio"
	"encoding/json"
	"os"
	"slices"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/commandline"
)

// A session of Codex (docs/architecture.md, "First adapters"), headless
// (headless H11): one `codex exec --json` per turn in the folder, the first
// with the first prompt, a restart `codex exec resume --last` (the folder's
// last conversation; one ship per folder), and every later turn `codex exec
// resume <thread id>`, which the hold starts for each line it is sent. Always
// without the question tool, so the session asks its questions over the fleet
// and no question holds a turn (#460).

// WakeCommand is what wakes an idle Codex session: the aeolus-fleet plugin's wake skill.
const WakeCommand = "$aeolus-fleet-wake"

const (
	// jsonEvents is added to every launch: the turn's events as JSON lines, which the hold keeps (headless H13, H14).
	jsonEvents = "--json"
	// noDaemon is left out of the configured flags: `codex exec` does not take it, and runs its turn in its own process. Configurations written for Codex in a terminal may still carry it.
	noDaemon = "--no-daemon"
	// noQuestionTool is added to every launch: Codex's question tool waits for an answer nobody gives.
	noQuestionTool = "--config=tools.experimental_request_user_input.enabled=false"
	// noApps is added to every launch: the user's ChatGPT apps, which Codex loads as its codex_apps MCP server, stay out of the session (#329).
	noApps     = "--config=features.apps=false"
	endOfFlags = "--"
)

// AdapterFlags are the flags the adapter adds itself, for config check.
var AdapterFlags = []commandline.AdapterFlag{
	{Flag: jsonEvents, When: "always"},
	{Flag: noQuestionTool, When: "always"},
	{Flag: noApps, When: "always"},
}

// CommandParts are `codex exec`, or `codex exec resume --last` on a restart, in parts: the configured flags but --no-daemon, --json, the question tool and the ChatGPT apps off, and the prompt last after `--`, so it never reads as a flag.
func CommandParts(flags []string, prompt string, isFirstStart bool) []commandline.Part {
	program := []string{"codex", "exec"}
	if !isFirstStart {
		program = append(program, "resume", "--last")
	}
	return commandline.WithWords([]commandline.Part{
		{Words: program},
		{Words: slices.DeleteFunc(slices.Clone(flags), func(flag string) bool { return flag == noDaemon }), Source: commandline.Configuration},
		{Words: []string{jsonEvents}, Source: commandline.Adapter},
		{Words: []string{noQuestionTool}, Source: commandline.Adapter},
		{Words: []string{noApps}, Source: commandline.Adapter},
		{Words: []string{endOfFlags, prompt}},
	})
}

// CommandLine is the words of CommandParts.
func CommandLine(flags []string, prompt string, isFirstStart bool) []string {
	return commandline.Words(CommandParts(flags, prompt, isFirstStart))
}

// ErrorIn is why Codex's start failed, from its last error event, a failed turn or an error the turn met (headless H13): an API error Codex passes on as JSON in its message by the API's own message; empty without one. Codex has no hook for a failed turn (#490).
func ErrorIn(events string) string {
	file, err := os.Open(events)
	if err != nil {
		return ""
	}
	defer file.Close()
	cause := ""
	lines := bufio.NewScanner(file)
	lines.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for lines.Scan() {
		var event struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			Error   struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(lines.Bytes(), &event) != nil {
			continue
		}
		switch event.Type {
		case "turn.failed":
			cause = apiMessageOf(event.Error.Message)
		case "error":
			cause = apiMessageOf(event.Message)
		}
	}
	return cause
}

// apiMessageOf is an API error's own message when the message is one as JSON, else the message.
func apiMessageOf(message string) string {
	var api struct {
		Error *struct {
			Message *string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(message), &api) == nil && api.Error != nil && api.Error.Message != nil {
		return *api.Error.Message
	}
	return message
}
