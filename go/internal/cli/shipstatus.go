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
		processes = append(processes, fmt.Sprintf("%d for %s", p.PID, age(now.Sub(started))))
	}
	processText := "none"
	if len(processes) > 0 {
		processText = strings.Join(processes, "; ")
	}
	for _, unreadable := range view.Unreadable {
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
		if unreadable.Fact == "activity" || unreadable.Fact == "processes" {
			continue
		}
		text = append(text, fmt.Sprintf("Unreadable: %s: %s", unreadable.Path, unreadable.Error))
	}
	return strings.Join(text, "\n")
}

func age(elapsed time.Duration) string {
	if elapsed < time.Minute {
		return fmt.Sprintf("%ds", max(0, int(elapsed.Round(time.Second)/time.Second)))
	}
	return fmt.Sprintf("%dm", int(elapsed.Round(time.Minute)/time.Minute))
}
