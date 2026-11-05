package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

const defaultLogLines = 50

// ActionRecord is a line of the log that says an action the loop took for a ship.
type ActionRecord struct {
	Time     string  `json:"time"`
	ShipID   string  `json:"shipId"`
	ShipName *string `json:"shipName,omitempty"`
	Action   string  `json:"action"`
	Outcome  string  `json:"outcome"`
	Next     *string `json:"next,omitempty"`
}

// MessageRecord is a line of the log that says a message of the loop.
type MessageRecord struct {
	Time    string `json:"time"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

// UnreadLine is a line of the log that is no record (an older line, a stack trace): shown as it is.
type UnreadLine struct {
	Line string `json:"line"`
}

func stringField(fields map[string]any, name string) (string, bool) {
	text, ok := fields[name].(string)
	return text, ok
}

func optionalField(fields map[string]any, name string) (*string, bool) {
	value, has := fields[name]
	if !has {
		return nil, true
	}
	text, ok := value.(string)
	return &text, ok
}

// readLogLine is a line of the log as its record, or as it is when it is none.
func readLogLine(line string) any {
	var fields map[string]any
	if json.Unmarshal([]byte(line), &fields) != nil || fields == nil {
		return UnreadLine{Line: line}
	}
	time, hasTime := stringField(fields, "time")
	if !hasTime {
		return UnreadLine{Line: line}
	}
	if message, ok := stringField(fields, "message"); ok {
		level, hasLevel := stringField(fields, "level")
		if hasLevel && (level == "info" || level == "warn") && len(fields) == 3 {
			return MessageRecord{Time: time, Level: level, Message: message}
		}
		return UnreadLine{Line: line}
	}
	shipID, hasShip := stringField(fields, "shipId")
	action, hasAction := stringField(fields, "action")
	outcome, hasOutcome := stringField(fields, "outcome")
	shipName, isNameRight := optionalField(fields, "shipName")
	next, isNextRight := optionalField(fields, "next")
	known := 4
	if shipName != nil {
		known++
	}
	if next != nil {
		known++
	}
	if !hasShip || !hasAction || !hasOutcome || !isNameRight || !isNextRight || len(fields) != known {
		return UnreadLine{Line: line}
	}
	return ActionRecord{Time: time, ShipID: shipID, ShipName: shipName, Action: action, Outcome: outcome, Next: next}
}

// renderLogLine is a line of the log as the operator reads it.
func renderLogLine(line string) string {
	switch record := readLogLine(line).(type) {
	case UnreadLine:
		return record.Line
	case MessageRecord:
		return fmt.Sprintf("%s %s %s", record.Time, record.Level, record.Message)
	case ActionRecord:
		ship := record.ShipID
		if record.ShipName != nil {
			ship = fmt.Sprintf("%s (%s)", record.ShipID, *record.ShipName)
		}
		next := ""
		if record.Next != nil {
			next = ". Next: " + *record.Next
		}
		return fmt.Sprintf("%s %s %s: %s%s", record.Time, ship, record.Action, record.Outcome, next)
	}
	return line
}

// compactJSON is a value as one line of JSON, as JSON.stringify writes it.
func compactJSON(value any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fmt.Sprintf(`{"error":%q}`, err.Error())
	}
	return strings.TrimSuffix(out.String(), "\n")
}

// logLines is --lines: a whole number from 0, or the default without it.
func logLines(command parsed) (int, error) {
	value, isGiven := command.values["--lines"]
	if !isGiven {
		return defaultLogLines, nil
	}
	number := 0.0
	if text := strings.TrimSpace(value); text != "" {
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return 0, refused(nil, "--lines takes a whole number")
		}
		number = parsed
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) || number < 0 || number > math.MaxInt32 {
		return 0, refused(nil, "--lines takes a whole number")
	}
	return int(number), nil
}

// logs is `logs [--lines <n>] [--follow]`: the last lines of the log, and with --follow each line written after, until the process is stopped.
func logs(at paths.Paths, machine Machine, command parsed) (answer, error) {
	lines, err := logLines(command)
	if err != nil {
		return answer{}, err
	}
	log := machine.ServiceLog(at)
	tail, err := log.Tail(lines)
	if err != nil {
		return answer{}, err
	}
	if !command.switches["--follow"] {
		where := map[string]any{}
		place := ""
		if log.Where.File != "" {
			where["file"] = log.Where.File
			place = log.Where.File
		} else {
			where["journal"] = log.Where.Journal
			place = fmt.Sprintf("the journal (%s)", log.Where.Journal)
		}
		read := []any{}
		rendered := []string{}
		for _, line := range tail {
			read = append(read, readLogLine(line))
			rendered = append(rendered, renderLogLine(line))
		}
		where["lines"] = read
		text := strings.Join(rendered, "\n")
		if len(tail) == 0 {
			text = fmt.Sprintf("No log lines yet in %s.", place)
		}
		return answer{data: where, text: text}, nil
	}
	write := func(line string) {
		if command.switches["--json"] {
			machine.Print(compactJSON(readLogLine(line)))
			return
		}
		machine.Print(renderLogLine(line))
	}
	for _, line := range tail {
		write(line)
	}
	if err := log.Follow(machine.Stop, write); err != nil {
		return answer{}, err
	}
	return answer{}, nil
}
