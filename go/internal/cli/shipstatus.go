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
	text := []string{
		fmt.Sprintf("Ship: %s (%s), %s, %s", view.ShipName, view.ShipID, view.Harness, place),
		fmt.Sprintf("State: %s since %s, %d restarts", view.State, view.Since, view.Restarts),
		"Activity: " + activity, "Processes: " + processText,
		fmt.Sprintf("Places: ship folder %s, hold %s", view.Places.ShipFolder, view.Places.Hold),
	}
	for _, unreadable := range view.Unreadable {
		if unreadable.Fact == "activity" || unreadable.Fact == "processes" || unreadable.Fact == "masking" {
			continue
		}
		text = append(text, fmt.Sprintf("Unreadable: %s: %s", unreadable.Path, unreadable.Error))
	}
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

func age(elapsed time.Duration) string {
	if elapsed < time.Minute {
		return fmt.Sprintf("%ds", max(0, int(elapsed.Round(time.Second)/time.Second)))
	}
	return fmt.Sprintf("%dm", int(elapsed.Round(time.Minute)/time.Minute))
}
