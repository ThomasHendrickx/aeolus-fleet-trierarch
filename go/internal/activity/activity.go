// Package activity is what a running session is doing, as its latest event
// says (monitoring 4.3, headless H14): its kind and, for a tool call, the
// tool, never any content. Each harness reads its own events with its own
// reader; this package finds the latest event a reader takes and when the
// session last wrote one.
package activity

import (
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/eventlog"
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
	files, err := eventlog.OpenDisk(events)
	if err != nil {
		return Activity{}, false
	}
	defer files.Close()
	latest, ok, err := OfFiles(files, read)
	return latest, ok && err == nil
}

// OfFiles reads the latest activity from open events files and reports read failures.
// The caller owns the files and closes them.
func OfFiles(files eventlog.Files, read func(event string) (Reading, bool)) (Activity, bool, error) {
	info, err := files[len(files)-1].Stat()
	if err != nil {
		return Activity{}, false, err
	}
	var last []string
	for line, err := range files.Lines() {
		if err != nil {
			return Activity{}, false, err
		}
		if len(line) == 0 {
			continue
		}
		if len(last) == eventLines {
			last = last[1:]
		}
		last = append(last, string(line))
	}
	reading, ok := Latest(last, read)
	if !ok {
		return Activity{}, false, nil
	}
	return Activity{At: info.ModTime(), Kind: reading.Kind, Tool: reading.Tool}, true, nil
}
