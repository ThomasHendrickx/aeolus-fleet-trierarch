package shipview

import (
	"encoding/json"
	"fmt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/seen"
	"path/filepath"
	"time"
)

// NoPassYet is the warning shown before any pass has completed.
const NoPassYet = "no pass yet: nothing below is current."

// Standing describes whether the local observations are current.
type Standing struct {
	// Service is the local service manager's running state.
	Service string `json:"service"`
	// LastPassAt is the last successful pass time in the local time zone.
	LastPassAt *string `json:"lastPassAt"`
	// PassFailure describes the last failed pass, if any.
	PassFailure *reconciler.PassFailure `json:"passFailure"`
	// IsCurrent says whether the observations have no standing warnings.
	IsCurrent bool `json:"isCurrent"`
	// Says lists independent warnings in service, failure and age order.
	Says []string `json:"says"`
}

// ReadStanding combines the pass files with the service manager's fact.
func ReadStanding(at paths.Paths, now time.Time, isRunning bool) (Standing, []Unreadable) {
	s := Standing{Service: "running", Says: []string{}}
	v := View{Unreadable: []Unreadable{}}
	read := func(path string, into any) {
		data, err := readFile(disk{}, path)
		if err == nil {
			err = json.Unmarshal(data, into)
		}
		v.record("standing", path, err)
	}
	var saved struct {
		PassFailure *reconciler.PassFailure `json:"passFailure"`
	}
	read(at.State, &saved)
	s.PassFailure = saved.PassFailure
	var snapshot seen.Snapshot
	read(filepath.Join(at.Home, "seen.json"), &snapshot)
	if snapshot.PassAt != "" {
		stamp, err := time.Parse(time.RFC3339, snapshot.PassAt)
		if err != nil {
			v.record("standing", filepath.Join(at.Home, "seen.json"), err)
		} else {
			local := stamp.In(now.Location()).Format(time.RFC3339)
			s.LastPassAt = &local
		}
	}
	if !isRunning {
		s.Service = "not running"
		s.Says = append(s.Says, "The trierarch's service is not running (aeolus-trierarch start): nothing below is current.")
	}
	if s.PassFailure != nil {
		since := s.PassFailure.Since
		if stamp, err := time.Parse(time.RFC3339, since); err == nil {
			since = stamp.In(now.Location()).Format("15:04:05")
		}
		s.Says = append(s.Says, fmt.Sprintf("The last pass failed, failing since %s: %s: nothing below is current.", since, s.PassFailure.Reason))
	}
	if s.LastPassAt != nil {
		if stamp, err := time.Parse(time.RFC3339, *s.LastPassAt); err == nil && now.Sub(stamp) > time.Minute {
			s.Says = append(s.Says, "The last pass was "+Age(now.Sub(stamp))+" ago: what is shown is stale.")
		}
	}
	for _, source := range v.Unreadable {
		s.Says = append(s.Says, fmt.Sprintf("unreadable: %s: %s", source.Path, source.Error))
	}
	if s.LastPassAt == nil && len(v.Unreadable) == 0 {
		s.Says = append(s.Says, NoPassYet)
	}
	s.IsCurrent = len(s.Says) == 0
	return s, v.Unreadable
}

// Age rounds elapsed time to seconds, minutes or hours.
func Age(elapsed time.Duration) string {
	if elapsed < time.Minute {
		return fmt.Sprintf("%ds", max(0, int(elapsed.Round(time.Second)/time.Second)))
	}
	if elapsed < time.Hour {
		return fmt.Sprintf("%dm", int(elapsed.Round(time.Minute)/time.Minute))
	}
	return fmt.Sprintf("%dh", int(elapsed.Round(time.Hour)/time.Hour))
}
