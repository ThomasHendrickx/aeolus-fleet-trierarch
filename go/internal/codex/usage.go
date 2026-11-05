package codex

import (
	"encoding/json"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/usage"
)

// newestLogsSearched is how many of the newest session logs are searched for the subscription's windows.
const newestLogsSearched = 10

// rolloutName is a session log's name, the start of its session in it.
var rolloutName = regexp.MustCompile(`(^|/)rollout-[^/]*\.jsonl$`)

// Usage is what Codex says of its usage (#353), from its session logs (rollout files under `sessions/<year>/<month>/<day>/`). A session log starts with the folder it ran in; each turn names its model, and each token count the session's total so far, so a turn's tokens are what the total grew by since the count before, counted to the login of the session that ran when it was written, when the ship's logins are given (api keys K8). Codex's input counts what it read from the cache: the input here is without it. Each token count also says how much of the subscription's windows is used: the newest log's last one is read. Codex documents no format for them: the reader is tested on a captured one.
type Usage struct {
	// Sessions is Codex's sessions folder: `sessions` in CODEX_HOME, or in `~/.codex`.
	Sessions string
	// MadeAt is when the ship's folder was made: what came before was another crew's.
	MadeAt func(folder string) (time.Time, error)

	appended usage.AppendedLines
	logs     map[string]*sessionLog
}

// total is a session's tokens so far, as a token count says them.
type total struct {
	InputTokens           *float64 `json:"input_tokens"`
	CachedInputTokens     float64  `json:"cached_input_tokens"`
	CacheWriteInputTokens float64  `json:"cache_write_input_tokens"`
	OutputTokens          *float64 `json:"output_tokens"`
}

// grown is what one token count grew by, of the model of its turn, and when it was written.
type grown struct {
	model  string
	at     time.Time
	tokens usage.Tokens
}

// sessionLog is one session log as read so far: the folder it ran in and since when, the model of its turn now, its last total, and what each token count grew by, kept with when so that the ship's logins split them when it is asked (K8).
type sessionLog struct {
	folder    string
	startedAt time.Time
	model     string
	total     total
	grown     []grown
}

// isoTime is a time as an ISO 8601 date and time in UTC, the only kind a session log is read with.
func isoTime(text string) (time.Time, bool) {
	if !strings.HasSuffix(text, "Z") {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	return parsed, err == nil
}

// grownBy is what the session's total grew by, input without what was read from or written to the cache.
func grownBy(now total, before total) usage.Tokens {
	cacheRead := now.CachedInputTokens - before.CachedInputTokens
	cacheWrite := now.CacheWriteInputTokens - before.CacheWriteInputTokens
	return usage.Tokens{
		Input:      math.Max(0, valueOr(now.InputTokens)-valueOr(before.InputTokens)-cacheRead-cacheWrite),
		Output:     valueOr(now.OutputTokens) - valueOr(before.OutputTokens),
		CacheRead:  cacheRead,
		CacheWrite: cacheWrite,
	}
}

func valueOr(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

type logLine struct {
	Timestamp *string         `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

func (l *sessionLog) read(line string) {
	var parsed logLine
	if json.Unmarshal([]byte(line), &parsed) != nil {
		return
	}
	switch parsed.Type {
	case "session_meta":
		var meta struct {
			Timestamp string  `json:"timestamp"`
			Cwd       *string `json:"cwd"`
		}
		if json.Unmarshal(parsed.Payload, &meta) != nil || meta.Cwd == nil {
			return
		}
		if startedAt, ok := isoTime(meta.Timestamp); ok {
			l.folder, l.startedAt = *meta.Cwd, startedAt
		}
	case "turn_context":
		var turn struct {
			Model *string `json:"model"`
		}
		if json.Unmarshal(parsed.Payload, &turn) == nil && turn.Model != nil {
			l.model = *turn.Model
		}
	case "event_msg":
		var count struct {
			Type string `json:"type"`
			Info *struct {
				TotalTokenUsage *total `json:"total_token_usage"`
			} `json:"info"`
		}
		if json.Unmarshal(parsed.Payload, &count) != nil || count.Type != "token_count" || count.Info == nil || count.Info.TotalTokenUsage == nil || l.model == "" {
			return
		}
		now := *count.Info.TotalTokenUsage
		if now.InputTokens == nil || now.OutputTokens == nil {
			return
		}
		// A count with no time of its own was written in the session it belongs to: since its start.
		at := l.startedAt
		if parsed.Timestamp != nil {
			written, ok := isoTime(*parsed.Timestamp)
			if !ok {
				return
			}
			at = written
		}
		l.grown = append(l.grown, grown{model: l.model, at: at, tokens: grownBy(now, l.total)})
		l.total = now
	}
}

// sessionLogs are every session log, oldest first, as their names start with when they started.
func (u *Usage) sessionLogs() []string {
	var logs []string
	_ = filepath.WalkDir(u.Sessions, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		relative, _ := filepath.Rel(u.Sessions, path)
		if !entry.IsDir() && rolloutName.MatchString(filepath.ToSlash(relative)) {
			logs = append(logs, path)
		}
		return nil
	})
	slices.Sort(logs)
	return logs
}

// TokensOf are the tokens the ship's sessions used since its folder was made, per model, login and UTC hour.
func (u *Usage) TokensOf(ship usage.Ship) ([]usage.HourTokens, error) {
	madeAt, err := u.MadeAt(ship.Folder)
	if err != nil {
		return nil, err
	}
	since := madeAt.UnixMilli()
	if u.logs == nil {
		u.logs = map[string]*sessionLog{}
	}
	var counted usage.Counter
	for _, path := range u.sessionLogs() {
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		// A log not written since the folder was made is another crew's: never read.
		if info.ModTime().UnixMilli() < since {
			continue
		}
		read, err := u.appended.Read(path)
		if err != nil {
			return nil, err
		}
		log := u.logs[path]
		if read.IsFromStart || log == nil {
			log = &sessionLog{}
		}
		for _, line := range read.Lines {
			log.read(line)
		}
		u.logs[path] = log
		if log.folder != ship.Folder || log.startedAt.UnixMilli() < since {
			continue
		}
		for _, each := range log.grown {
			used := usage.HourTokens{Model: each.model, Hour: usage.HourOf(each.at), Tokens: each.tokens}
			if ship.Logins != nil {
				used.Login = ship.Logins.At(each.at)
			}
			counted.Add(used)
		}
	}
	return counted.List(), nil
}

type rateWindow struct {
	UsedPercent   *float64 `json:"used_percent"`
	WindowMinutes *float64 `json:"window_minutes"`
	ResetsAt      *float64 `json:"resets_at"`
}

// rateLimitsOf are the windows a token count line says; false for a line that says none.
func rateLimitsOf(line string) ([]rateWindow, bool) {
	var parsed logLine
	if json.Unmarshal([]byte(line), &parsed) != nil || parsed.Type != "event_msg" {
		return nil, false
	}
	var count struct {
		Type       string `json:"type"`
		RateLimits *struct {
			Primary   *rateWindow `json:"primary"`
			Secondary *rateWindow `json:"secondary"`
		} `json:"rate_limits"`
	}
	if json.Unmarshal(parsed.Payload, &count) != nil || count.Type != "token_count" || count.RateLimits == nil {
		return nil, false
	}
	windows := []rateWindow{}
	for _, window := range []*rateWindow{count.RateLimits.Primary, count.RateLimits.Secondary} {
		if window == nil {
			continue
		}
		if window.UsedPercent == nil || window.WindowMinutes == nil || window.ResetsAt == nil {
			return nil, false
		}
		windows = append(windows, *window)
	}
	return windows, true
}

// Subscription is how much of Codex's subscription is used now, per window, as the newest session log's last token count says it; none before Codex wrote any that says it.
func (u *Usage) Subscription() ([]usage.Window, error) {
	logs := u.sessionLogs()
	logs = logs[max(0, len(logs)-newestLogsSearched):]
	for at := len(logs) - 1; at >= 0; at-- {
		text, err := os.ReadFile(logs[at])
		if err != nil {
			return nil, err
		}
		var last []rateWindow
		isFound := false
		for _, line := range strings.Split(string(text), "\n") {
			if windows, ok := rateLimitsOf(line); ok {
				last, isFound = windows, true
			}
		}
		if !isFound {
			continue
		}
		windows := []usage.Window{}
		for _, window := range last {
			windows = append(windows, usage.Window{WindowMinutes: *window.WindowMinutes, UsedPercent: math.Min(100, math.Max(0, *window.UsedPercent)), ResetsAt: time.UnixMilli(int64(*window.ResetsAt * 1000)).UTC()})
		}
		return windows, nil
	}
	return nil, nil
}
