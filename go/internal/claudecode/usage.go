package claudecode

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/usage"
)

// syntheticModel is the model Claude Code names a message it made itself, such as an error, that no model answered.
const syntheticModel = "<synthetic>"

// usageProbeModel is the cheapest model, the subscription's short turn runs on.
const usageProbeModel = "haiku"

// windowMinutes are Claude Code's windows by the name it gives them, in minutes.
var windowMinutes = map[string]float64{"five_hour": 300, "seven_day": 10_080}

// Usage is what Claude Code says of its usage (#353). A ship's tokens come from the transcripts in its projects folder: its folder's conversations and their sub-agents', one line per content block, each line of a message carrying the message's whole usage, so each message counts once by its id, to the login of the session that wrote it when the ship's logins are given (api keys K8). Its subscription comes from the rate limit event a print-mode turn streams, a short turn on the cheapest model, from an empty folder. Claude Code documents neither: the reader is tested on captured ones.
type Usage struct {
	// Projects is Claude Code's projects folder.
	Projects string
	// MadeAt is when the ship's folder was made: what came before was another crew's.
	MadeAt func(folder string) (time.Time, error)
	Run    detection.Runner
	// NeutralFolder is a new empty folder to run the turn from, so no project's hooks or settings apply and it is never a ship; removed after.
	NeutralFolder func() (string, error)
	// Program is Claude Code's command; empty is claude.
	Program string

	appended    usage.AppendedLines
	transcripts map[string]*transcriptTotals
}

// transcriptTotals are one transcript as read so far: the messages it counted, and their tokens per model, login and hour.
type transcriptTotals struct {
	seen    map[string]bool
	counted usage.Counter
}

type assistantLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		ID    *string `json:"id"`
		Model *string `json:"model"`
		Usage *struct {
			InputTokens              *float64 `json:"input_tokens"`
			OutputTokens             *float64 `json:"output_tokens"`
			CacheReadInputTokens     *float64 `json:"cache_read_input_tokens"`
			CacheCreationInputTokens *float64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

// isoTime is a time as an ISO 8601 date and time in UTC, the only kind a transcript is read with.
func isoTime(text string) (time.Time, bool) {
	if !strings.HasSuffix(text, "Z") {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	return parsed, err == nil
}

func valueOr(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

// TokensOf are the tokens the ship's sessions used since its folder was made, per model, login and UTC hour.
func (u *Usage) TokensOf(ship usage.Ship) ([]usage.HourTokens, error) {
	since, err := u.MadeAt(ship.Folder)
	if err != nil {
		return nil, err
	}
	project := filepath.Join(u.Projects, projectName(ship.Folder))
	var counted usage.Counter
	for _, path := range transcriptsIn(project) {
		totals, err := u.readTranscript(path, since, ship.Logins)
		if err != nil {
			return nil, err
		}
		for _, used := range totals.counted.List() {
			counted.Add(used)
		}
	}
	return counted.List(), nil
}

// projectName is Claude Code's name for a folder's conversations: every character other than a letter or digit as a dash.
func projectName(folder string) string {
	return strings.Map(func(character rune) rune {
		if character < 128 && (character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9') {
			return character
		}
		return '-'
	}, folder)
}

// transcriptsIn are the conversations Claude Code keeps of the folder: each `.jsonl` in its projects folder, and the sub-agents' of each.
func transcriptsIn(project string) []string {
	entries, _ := os.ReadDir(project)
	var own, subagents []string
	for _, entry := range entries {
		switch {
		case entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".jsonl"):
			own = append(own, filepath.Join(project, entry.Name()))
		case entry.IsDir():
			folder := filepath.Join(project, entry.Name(), "subagents")
			names, _ := os.ReadDir(folder)
			for _, name := range names {
				if strings.HasSuffix(name.Name(), ".jsonl") {
					subagents = append(subagents, filepath.Join(folder, name.Name()))
				}
			}
		}
	}
	return append(own, subagents...)
}

// readTranscript reads a transcript on, never again from its start: a message counted to a login stays counted to it, as a later change of login is kept from its start on.
func (u *Usage) readTranscript(path string, since time.Time, logins *usage.Logins) (*transcriptTotals, error) {
	read, err := u.appended.Read(path)
	if err != nil {
		return nil, err
	}
	if u.transcripts == nil {
		u.transcripts = map[string]*transcriptTotals{}
	}
	totals := u.transcripts[path]
	if read.IsFromStart || totals == nil {
		totals = &transcriptTotals{seen: map[string]bool{}}
	}
	for _, line := range read.Lines {
		var parsed assistantLine
		if json.Unmarshal([]byte(line), &parsed) != nil || parsed.Type != "assistant" || parsed.Message == nil {
			continue
		}
		message := parsed.Message
		at, ok := isoTime(parsed.Timestamp)
		if !ok || message.ID == nil || message.Model == nil || message.Usage == nil || message.Usage.InputTokens == nil || message.Usage.OutputTokens == nil {
			continue
		}
		if *message.Model == syntheticModel || totals.seen[*message.ID] || at.UnixMilli() < since.UnixMilli() {
			continue
		}
		totals.seen[*message.ID] = true
		used := usage.HourTokens{Model: *message.Model, Hour: usage.HourOf(at), Tokens: usage.Tokens{
			Input:      *message.Usage.InputTokens,
			Output:     *message.Usage.OutputTokens,
			CacheRead:  valueOr(message.Usage.CacheReadInputTokens),
			CacheWrite: valueOr(message.Usage.CacheCreationInputTokens),
		}}
		if logins != nil {
			used.Login = logins.At(at)
		}
		totals.counted.Add(used)
	}
	u.transcripts[path] = totals
	return totals, nil
}

// Subscription is how much of Claude Code's subscription is used now, per window, as a short print-mode turn streams it; none when the turn says nothing of its windows.
func (u *Usage) Subscription() ([]usage.Window, error) {
	folder, err := u.NeutralFolder()
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(folder)
	program := u.Program
	if program == "" {
		program = "claude"
	}
	ran := u.Run(context.Background(), detection.Command{
		Program: program,
		Args:    []string{"-p", "--model", usageProbeModel, "--max-turns", "1", "--output-format", "stream-json", "--verbose", probePrompt},
		Dir:     folder,
		Timeout: ProbeTimeout,
	})
	return windowsIn(ran.Stdout), nil
}

// rateWindow is one of a rate limit event's windows.
type rateWindow struct {
	name        string
	utilization float64
	resetsAt    float64
}

// windowsIn are the windows a print-mode turn's stream says, from its last rate limit event; none when it says none.
func windowsIn(stream string) []usage.Window {
	var last []rateWindow
	isFound := false
	for _, line := range strings.Split(stream, "\n") {
		if windows, ok := rateLimitEventOf(line); ok {
			last, isFound = windows, true
		}
	}
	if !isFound {
		return nil
	}
	var windows []usage.Window
	for _, window := range last {
		minutes, ok := windowMinutes[window.name]
		if !ok {
			continue
		}
		used := math.Min(100, math.Max(0, math.Floor(window.utilization*100*100+0.5)/100))
		windows = append(windows, usage.Window{WindowMinutes: minutes, UsedPercent: used, ResetsAt: time.UnixMilli(int64(window.resetsAt * 1000)).UTC()})
	}
	return windows
}

// rateLimitEventOf is a rate limit event's windows in the order the line names them; false for a line that is none.
func rateLimitEventOf(line string) ([]rateWindow, bool) {
	var event struct {
		Type          string `json:"type"`
		RateLimitInfo *struct {
			UnifiedWindows json.RawMessage `json:"unifiedWindows"`
		} `json:"rate_limit_info"`
	}
	if json.Unmarshal([]byte(line), &event) != nil || event.Type != "rate_limit_event" || event.RateLimitInfo == nil {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(event.RateLimitInfo.UnifiedWindows))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, false
	}
	windows := []rateWindow{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, false
		}
		name, _ := token.(string)
		var window struct {
			Utilization *float64 `json:"utilization"`
			ResetsAt    *float64 `json:"resetsAt"`
		}
		if decoder.Decode(&window) != nil || window.Utilization == nil || window.ResetsAt == nil {
			return nil, false
		}
		windows = append(windows, rateWindow{name: name, utilization: *window.Utilization, resetsAt: *window.ResetsAt})
	}
	return windows, true
}
