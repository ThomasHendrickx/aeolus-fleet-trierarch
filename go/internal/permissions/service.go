package permissions

import (
	"context"
	"strings"
	"unicode/utf16"
)

const reportNoteLimit = 200

// Report is the state and note at wait entry. Revision detects a later report.
type Report struct {
	State    string `json:"state"`
	Note     string `json:"note"`
	Revision string `json:"reportedAt"`
}

// Reports reads and writes the current crew's report, leaving details untouched.
type Reports interface {
	ReadReport(context.Context, string) (Report, error)
	WriteReport(context.Context, string, Report) error
}

// Service owns a person-owned ship's wait in the trierarch process.
type Service struct {
	Owners  OwnerReader
	Reports Reports
	Clock   Clock
	Log     func(string)
}

// Await reads the owner for this call, reports its wait and restores the report
// on every end, unless another report has replaced it meanwhile.
func (s Service) Await(ctx context.Context, ship, title string) Decision {
	owner, err := s.Owners.Owner(ctx, ship)
	if err != nil {
		return Decision{Behavior: "deny", Message: "could not read this ship's owner: nobody is asked"}
	}
	if !owner.IsPerson {
		return Decision{Behavior: "deny", Message: "this ship's owner is argo: nobody is asked"}
	}
	before, err := s.Reports.ReadReport(ctx, ship)
	if err != nil {
		return s.failed(err)
	}
	waiting := Report{State: "working", Note: waitNote(title)}
	if ctx.Err() != nil {
		return Decision{Behavior: "deny", Message: "permission call cancelled"}
	}
	if err = s.Reports.WriteReport(context.WithoutCancel(ctx), ship, waiting); err != nil {
		return s.failed(err)
	}
	current, err := s.Reports.ReadReport(context.WithoutCancel(ctx), ship)
	if err != nil {
		return s.failed(err)
	}
	if current.State == waiting.State && current.Note == waiting.Note {
		defer func() {
			// The stream can already be gone; restoration still has a bounded adapter
			// request and never inherits the cancelled tool request.
			restore := context.WithoutCancel(ctx)
			last, err := s.Reports.ReadReport(restore, ship)
			if err != nil {
				s.failed(err)
				return
			}
			if last == current {
				if err = s.Reports.WriteReport(restore, ship, before); err != nil {
					s.failed(err)
				}
			}
		}()
	}
	return Wait(ctx, s.Clock)
}

func (s Service) failed(err error) Decision {
	if s.Log != nil {
		s.Log("permission wait: " + err.Error())
	}
	return Decision{Behavior: "deny", Message: "could not wait for this ship's owner: nobody is asked"}
}

func waitNote(title string) string {
	note := "waiting for its owner: " + strings.Join(strings.Fields(title), " ")
	// Core counts JavaScript string units, including two for a non-BMP rune.
	units := utf16.Encode([]rune(note))
	if len(units) > reportNoteLimit {
		units = units[:reportNoteLimit]
		if units[reportNoteLimit-1] >= 0xd800 && units[reportNoteLimit-1] <= 0xdbff {
			units = units[:reportNoteLimit-1]
		}
	}
	return string(utf16.Decode(units))
}
