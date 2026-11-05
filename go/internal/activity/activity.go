// Package activity is what a running session is doing, as its latest event
// says (monitoring 4.3, headless H14): its kind and, for a tool call, the
// tool, never any content. Each harness reads its own events with its own
// reader; this package finds the latest event a reader takes and when the
// session last wrote one.
package activity

import (
	"bufio"
	"os"
	"time"
)

// eventLines is how many of the last event lines are read.
const eventLines = 200

// Reading is what one event says: its kind (text, tool, result or error) and the tool of a tool call.
type Reading struct {
	Kind string
	Tool string
}

// Activity is a session's reading, at when its events were last written.
type Activity struct {
	At   time.Time
	Kind string
	Tool string
}

// Latest is the reading of the newest of the events that reads as activity; none when none does.
func Latest(events []string, read func(event string) (Reading, bool)) (Reading, bool) {
	for i := len(events) - 1; i >= 0; i-- {
		if reading, ok := read(events[i]); ok {
			return reading, true
		}
	}
	return Reading{}, false
}

// Of is the activity the last event lines of the events file show, at when the file was last written; none while the file is missing or shows none.
func Of(events string, read func(event string) (Reading, bool)) (Activity, bool) {
	file, err := os.Open(events)
	if err != nil {
		return Activity{}, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Activity{}, false
	}
	var last []string
	lines := bufio.NewScanner(file)
	lines.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for lines.Scan() {
		if lines.Text() == "" {
			continue
		}
		if len(last) == eventLines {
			last = last[1:]
		}
		last = append(last, lines.Text())
	}
	reading, ok := Latest(last, read)
	if !ok {
		return Activity{}, false
	}
	return Activity{At: info.ModTime(), Kind: reading.Kind, Tool: reading.Tool}, true
}
