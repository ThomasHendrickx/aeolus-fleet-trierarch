package copilot

import (
	"bufio"
	"encoding/json"
	"os"
	"regexp"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/commandline"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
)

// A session of the GitHub Copilot CLI (docs/architecture.md, "First
// adapters"; design harnesses/cursor-copilot, CC4), headless: one `copilot -p`
// per turn in the folder, as Codex runs one `codex exec`, its output as JSON
// lines, every tool allowed and its question tool off, so a turn asks
// nothing. Every later turn resumes the session by the id the last turn's
// result named; a restart too, since `--continue` takes the latest session of
// the machine, whatever its folder (Copilot CLI 1.0.105).

// WakePrompt is the prompt of a restarted session: Copilot has no wake command, so the start context and the crew-a-ship skill say the rest.
const WakePrompt = "Aeolus started this session again: go on crewing this folder's Aeolus ship as the crew-a-ship skill says."

// ProvenVersions are the Copilot CLI builds whose hook roles the aeolus-fleet plugin is proven on (design harnesses/cursor-copilot, S3).
var ProvenVersions = []string{"1.0.105"}

const (
	// jsonOutput is added to every launch: the turn's events as JSON lines, which the hold keeps (headless H13).
	jsonOutput = "--output-format=json"
	// allowAllTools is added to every launch: `copilot -p` runs no tool without it, and running every tool without asking is the mode a session the trierarch runs is in (decision 0016).
	allowAllTools = "--allow-all-tools"
	// noAskUser is added to every launch: Copilot's question tool waits for an answer nobody gives (#460).
	noAskUser  = "--no-ask-user"
	resumeFlag = "--resume="
	promptFlag = "--prompt="
	// errorPrefix is how Copilot starts the error it writes on stderr.
	errorPrefix = "Error: "
)

// AdapterFlags are the flags the adapter adds itself, for config check.
var AdapterFlags = []commandline.AdapterFlag{
	{Flag: jsonOutput, When: "always"},
	{Flag: allowAllTools, When: "always"},
	{Flag: noAskUser, When: "always"},
}

// CommandParts are `copilot` in parts, the configured flags, JSON output, every tool allowed and no question tool, then the session to resume when there is one, and the prompt last as the value of --prompt, so it never reads as a flag.
func CommandParts(flags []string, line string, sessionID string) []commandline.Part {
	last := []string{}
	if sessionID != "" {
		last = append(last, resumeFlag+sessionID)
	}
	return commandline.WithWords([]commandline.Part{
		{Words: []string{"copilot"}},
		{Words: flags, Source: commandline.Configuration},
		{Words: []string{jsonOutput}, Source: commandline.Adapter},
		{Words: []string{allowAllTools}, Source: commandline.Adapter},
		{Words: []string{noAskUser}, Source: commandline.Adapter},
		{Words: append(last, promptFlag+line)},
	})
}

// CommandLine is the words of CommandParts.
func CommandLine(flags []string, line string, sessionID string) []string {
	return commandline.Words(CommandParts(flags, line, sessionID))
}

// event is the part of a line of Copilot's output, or of a stderr line the hold kept, that the trierarch reads.
type event struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Line      string `json:"line"`
	Data      struct {
		Message string `json:"message"`
	} `json:"data"`
}

// eachEvent calls the function with each event in the events file, in order.
func eachEvent(events string, each func(said event)) {
	file, err := os.Open(events)
	if err != nil {
		return
	}
	defer file.Close()
	lines := bufio.NewScanner(file)
	lines.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for lines.Scan() {
		var said event
		if json.Unmarshal(lines.Bytes(), &said) == nil {
			each(said)
		}
	}
}

// ErrorIn is why Copilot's start failed (headless H13): its last error, a session error, which a failed model call writes, or the error it wrote on stderr, as a missing login or a refused model fire no hook and write no event; empty without one.
func ErrorIn(events string) string {
	cause := ""
	eachEvent(events, func(said event) {
		switch {
		case said.Type == "session.error" && said.Data.Message != "":
			cause = said.Data.Message
		case said.Type == hold.StderrEvent && strings.HasPrefix(said.Line, errorPrefix):
			cause = strings.TrimPrefix(said.Line, errorPrefix)
		}
	})
	return cause
}

// LastSessionIn is the session the last turn in the events named, by its result, the only event naming it; empty when no turn named one.
func LastSessionIn(events string) string {
	sessionID := ""
	eachEvent(events, func(said event) {
		if said.Type == "result" && said.SessionID != "" {
			sessionID = said.SessionID
		}
	})
	return sessionID
}

// versionPattern is a version as Copilot says it, such as 1.0.105.
var versionPattern = regexp.MustCompile(`\d+\.\d+\.\d+`)
