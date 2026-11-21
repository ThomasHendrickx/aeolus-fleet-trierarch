package shipview

import (
	"bufio"
	"context"
	"encoding/json"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mask"
)

// Line is a whole, masked event with its timestamp and harness reading, when present.
type Line struct {
	At   string `json:"at"`
	Kind string `json:"kind"`
	Tool string `json:"tool,omitempty"`
	Line string `json:"line"`
}

// lastLines matches the activity reader's 200-line window (design D14).
const lastLines = 200

func (v *View) readEvents(ctx context.Context, files Files, path string, read func([]string) (activity.Reading, bool), masker mask.Masker, now time.Time) {
	if err := ctx.Err(); err != nil {
		v.record("activity", path, err)
		return
	}
	file, err := files.Open(path)
	v.record("activity", path, err)
	if err != nil {
		return
	}
	defer file.Close()
	info, err := file.Stat()
	v.record("activity", path, err)
	if err != nil {
		return
	}
	var tail []string
	lines := bufio.NewScanner(file)
	lines.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for lines.Scan() {
		if err := ctx.Err(); err != nil {
			v.record("activity", path, err)
			return
		}
		if len(tail) == lastLines {
			tail = tail[1:]
		}
		tail = append(tail, lines.Text())
	}
	v.record("activity", path, lines.Err())
	if lines.Err() != nil {
		return
	}
	canShow := true
	for _, failure := range v.Unreadable {
		if failure.Fact == "masking" {
			canShow = false
		}
	}
	for _, raw := range tail {
		var reading activity.Reading
		if read != nil {
			if found, ok := read([]string{raw}); ok {
				reading = found
				v.Session.Activity = &Activity{Kind: found.Kind, Tool: masker.Line(found.Tool), At: info.ModTime().In(now.Location()).Format(time.RFC3339)}
			}
		}
		if canShow {
			v.Lines = append(v.Lines, Line{At: lineTime(raw, now.Location()), Kind: reading.Kind, Tool: masker.Line(reading.Tool), Line: masker.Line(raw)})
		}
	}
}

func lineTime(raw string, location *time.Location) string {
	var event struct {
		Timestamp string `json:"timestamp"`
	}
	if json.Unmarshal([]byte(raw), &event) != nil {
		return ""
	}
	if at, err := time.Parse(time.RFC3339Nano, event.Timestamp); err == nil {
		return at.In(location).Format(time.RFC3339Nano)
	}
	return ""
}
