package shipview

import (
	"context"
	"encoding/json"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/ended"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/eventlog"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mask"
)

// Line is a whole, masked event with its timestamp and harness reading, when present.
type Line = ended.Line

// lastLines matches the activity reader's 200-line window (design D14).
const lastLines = 200

func (v *View) readEvents(ctx context.Context, files Files, path string, read func([]string) (activity.Reading, bool), masker mask.Masker, now time.Time) {
	if err := ctx.Err(); err != nil {
		v.record("activity", path, err)
		return
	}
	events, err := eventlog.Open(path, files.Open)
	v.record("activity", path, err)
	if err != nil {
		return
	}
	defer events.Close()
	info, err := events[len(events)-1].Stat()
	v.record("activity", path, err)
	if err != nil {
		return
	}
	var tail []string
	for line, err := range events.Lines() {
		if err != nil {
			v.record("activity", path, err)
			return
		}
		if err := ctx.Err(); err != nil {
			v.record("activity", path, err)
			return
		}
		if len(tail) == lastLines {
			tail = tail[1:]
		}
		tail = append(tail, string(line))
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
