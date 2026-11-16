package cursor

import (
	"bufio"
	"encoding/json"
	"os"
	"regexp"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/commandline"
)

// AdapterFlags are the mechanism flags added on every Cursor turn; --force remains the operator's choice.
var AdapterFlags = []commandline.AdapterFlag{
	{Flag: "--output-format=stream-json", When: "always"},
	{Flag: "--trust", When: "always"},
	{Flag: "--print", When: "always"},
}

// CommandParts keeps a positional prompt outside option parsing, with an explicit chat id on later turns (CC4).
func CommandParts(flags []string, line, sessionID string) []commandline.Part {
	parts := []commandline.Part{{Words: []string{"agent"}}, {Words: flags, Source: commandline.Configuration}}
	for _, flag := range AdapterFlags {
		parts = append(parts, commandline.Part{Words: []string{flag.Flag}, Source: commandline.Adapter})
	}
	var last []string
	if sessionID != "" {
		last = append(last, "--resume="+sessionID)
	}
	return commandline.WithWords(append(parts, commandline.Part{Words: append(last, "--", line)}))
}

// CommandLine is the words of CommandParts.
func CommandLine(flags []string, line, sessionID string) []string {
	return commandline.Words(CommandParts(flags, line, sessionID))
}

type event struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	SessionID string `json:"session_id"`
	IsError   *bool  `json:"is_error"`
	Result    string `json:"result"`
	Line      string `json:"line"`
}

func eachEvent(file string, each func(event)) {
	input, err := os.Open(file)
	if err != nil {
		return
	}
	defer input.Close()
	lines := bufio.NewScanner(input)
	lines.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for lines.Scan() {
		var said event
		if json.Unmarshal(lines.Bytes(), &said) == nil {
			each(said)
		}
	}
}

// LastSessionIn reads system init, which names the chat even before an interrupted turn's model result.
func LastSessionIn(file string) string {
	id := ""
	eachEvent(file, func(said event) {
		if said.Type == "system" && said.Subtype == "init" && said.SessionID != "" {
			id = said.SessionID
		}
	})
	return id
}

// StderrEvent is how the hold preserves Cursor's launch errors, which precede any stream-json event.
func StderrEvent(line string) string {
	data, _ := json.Marshal(struct {
		Type string `json:"type"`
		Line string `json:"line"`
	}{"aeolus.stderr", line})
	return string(data)
}

// ErrorIn reads the last failure, clearing older failures once a successful turn completes (H13).
func ErrorIn(file string) string {
	cause := ""
	eachEvent(file, func(said event) {
		switch {
		case said.Type == "result" && said.IsError != nil && !*said.IsError:
			cause = ""
		case said.Type == "result" && said.IsError != nil && *said.IsError && said.Result != "":
			cause = said.Result
		case said.Type == "aeolus.stderr" && strings.TrimSpace(said.Line) != "":
			cause = strings.TrimSpace(said.Line)
		}
	})
	return cause
}

var refusedModel = regexp.MustCompile(`^Cannot use this model: (.+?)\. Available models:`)

// RefusedModelIn names a captured model refusal only when it concerns the model this launch requested.
func RefusedModelIn(file, model string) string {
	match := refusedModel.FindStringSubmatch(ErrorIn(file))
	if len(match) == 2 && (model == "" || model == match[1]) {
		return match[1]
	}
	return ""
}
