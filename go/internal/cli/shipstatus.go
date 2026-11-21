package cli

import (
	"fmt"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipview"
)

func shipStatus(at paths.Paths, machine Machine, ship string) (answer, error) {
	now := time.Now()
	if machine.Now != nil {
		now = machine.Now()
	}
	view, err := shipview.Ship(at, ship, now)
	if err != nil {
		return answer{}, err
	}
	isRunning := false
	var serviceFailure *shipview.Unreadable
	if machine.Service != nil {
		manager, err := machine.Service(at).Status()
		if err != nil {
			serviceFailure = &shipview.Unreadable{Fact: "standing", Path: manager.File, Error: err.Error()}
		} else {
			isRunning = manager.IsRunning
		}
	}
	standing, unreadable := shipview.ReadStanding(at, now, isRunning || serviceFailure != nil)
	if serviceFailure != nil {
		standing.Service = "unreadable"
		standing.IsCurrent = false
		standing.Says = append([]string{fmt.Sprintf("unreadable: %s: %s", serviceFailure.Path, serviceFailure.Error)}, standing.Says...)
		unreadable = append(unreadable, *serviceFailure)
	}
	view.Trierarch = standing
	for _, source := range unreadable {
		duplicate := false
		for _, existing := range view.Unreadable {
			if existing.Path == source.Path && existing.Error == source.Error {
				duplicate = true
				break
			}
		}
		if !duplicate {
			view.Unreadable = append(view.Unreadable, source)
		}
	}
	return answer{data: view, text: describeShip(view, now)}, nil
}

func describeShip(view shipview.View, now time.Time) string {
	place := "on the host"
	if view.IsContainer {
		place = "in a container"
	}
	activity := "none"
	if latest := view.Session.Activity; latest != nil {
		activity = latest.Kind
		if latest.Tool != "" {
			activity += " " + latest.Tool
		}
		at, _ := time.Parse(time.RFC3339, latest.At)
		activity += ", " + age(now.Sub(at)) + " ago"
	}
	processes := []string{}
	for _, p := range view.Session.Processes {
		started, _ := time.Parse(time.RFC3339, p.StartedAt)
		processes = append(processes, fmt.Sprintf("%d for %s: %s", p.PID, age(now.Sub(started)), p.Command))
	}
	processText := "none"
	if len(processes) > 0 {
		processText = strings.Join(processes, "; ")
	}
	for _, unreadable := range view.Unreadable {
		if unreadable.Fact == "masking" {
			processText = "not shown: cannot read " + unreadable.Path + " to mask it (" + unreadable.Error + ")"
		}
		value := fmt.Sprintf("unreadable: %s: %s", unreadable.Path, unreadable.Error)
		if unreadable.Fact == "processes" {
			processText = value
		}
		if unreadable.Fact == "activity" {
			activity = value
		}
	}
	turn, inbox := seenText(view, now)
	text := []string{
		fmt.Sprintf("Ship: %s (%s), %s, %s", view.ShipName, view.ShipID, view.Harness, place),
		fmt.Sprintf("State: %s since %s, %d restarts", view.State, view.Since, view.Restarts),
		"Turn: " + turn, "Activity: " + activity, "Inbox: " + inbox, "Processes: " + processText,
		fmt.Sprintf("Places: ship folder %s, hold %s", view.Places.ShipFolder, view.Places.Hold),
	}
	for _, unreadable := range view.Unreadable {
		if unreadable.Fact == "activity" || unreadable.Fact == "processes" || unreadable.Fact == "masking" || unreadable.Fact == "seen" || unreadable.Fact == "standing" {
			continue
		}
		text = append(text, fmt.Sprintf("Unreadable: %s: %s", unreadable.Path, unreadable.Error))
	}
	standing := strings.Join(view.Trierarch.Says, " ")
	if view.Trierarch.IsCurrent {
		stamp, _ := time.Parse(time.RFC3339, *view.Trierarch.LastPassAt)
		standing = "current, last pass " + age(now.Sub(stamp)) + " ago"
	}
	text = append(text, "Trierarch: "+standing)
	lineFailure := ""
	for _, unreadable := range view.Unreadable {
		if unreadable.Fact == "activity" {
			lineFailure = fmt.Sprintf("unreadable: %s: %s", unreadable.Path, unreadable.Error)
		}
		if unreadable.Fact == "masking" {
			lineFailure = "not shown: cannot read " + unreadable.Path + " to mask it (" + unreadable.Error + ")"
			break
		}
	}
	if lineFailure != "" {
		text = append(text, "Last lines: "+lineFailure)
	} else {
		text = append(text, "Last lines:")
		for _, line := range view.Lines {
			stamp := "--:--:--"
			if at, err := time.Parse(time.RFC3339Nano, line.At); err == nil {
				stamp = at.Format("15:04:05")
			}
			prefix := stamp
			if line.Kind != "" {
				prefix += " " + line.Kind
			}
			if line.Tool != "" {
				prefix += " " + line.Tool
			}
			text = append(text, "  "+prefix+" "+line.Line)
		}
	}
	return strings.Join(text, "\n")
}

func age(elapsed time.Duration) string { return shipview.Age(elapsed) }

// seenText keeps the wording for unavailable observations in one place.
func seenText(view shipview.View, now time.Time) (string, string) {
	turn, inbox := "unknown", "not seen yet"
	if view.Session.Status != "running" {
		turn = "-"
	}
	if marked := view.Session.Turn; marked != nil {
		turn = marked.State
		if marked.Since != "" {
			turn += " since " + marked.Since
		}
		at, _ := time.Parse(time.RFC3339, marked.SeenAt)
		turn += ", seen " + age(now.Sub(at)) + " ago"
	}
	if seen := view.Inbox; seen != nil {
		inbox = "not watched while no session runs"
		if seen.IsWatched {
			at, _ := time.Parse(time.RFC3339, seen.SeenAt)
			inbox = fmt.Sprintf("%d waiting, %d forced, seen %s ago", seen.Waiting, seen.Forced, age(now.Sub(at)))
		}
	}
	for _, unreadable := range view.Unreadable {
		if unreadable.Fact == "seen" || unreadable.Fact == "standing" {
			value := fmt.Sprintf("unreadable: %s: %s", unreadable.Path, unreadable.Error)
			return value, value
		}
	}
	return turn, inbox
}
