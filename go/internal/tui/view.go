// Package tui shows local ship facts without steering a ship or calling the fleet.
package tui

import (
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipview"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/style"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

type screen int

const (
	listScreen screen = iota
	shipScreen
	endScreen
)

// Model holds the last facts read; View performs no I/O.
type Model struct {
	isOpening bool
	readAt    time.Time
	hasRead   bool
	source    Source
	request   uint64
	from      screen
	machine   shipview.Machine
	ship      shipview.View
	screen    screen
	selected  int
	offset    int
	width     int
	height    int
	now       time.Time
	failure   string
	notice    string
	look      style.Style
}

// View renders the current screen, clipping after the reader has masked every line.
func (m Model) View() string {
	var lines []string
	if m.isOpening || (m.source != nil && !m.hasRead && len(m.machine.Ships) == 0 && m.failure == "") {
		return "aeolus-trierarch\nReading local ship facts…\nq quit"
	}
	standing := m.machine.Trierarch
	if m.screen != listScreen {
		standing = m.ship.Trierarch

	}
	var banners []string
	for _, warning := range standing.Says {
		banners = append(banners, "! "+clean(warning))
	}
	fullHeight := m.height
	m.height = max(1, m.height-len(banners))
	if m.screen == listScreen {
		lines = m.listView()
	} else if m.screen == endScreen {
		lines = m.endView()
	} else {
		lines = m.shipView()
	}
	m.height = fullHeight
	lines = append(banners, lines...)
	if m.failure != "" {
		lines = append([]string{m.failure}, lines...)
	}
	if m.notice != "" {
		lines = append([]string{m.notice}, lines...)
	}
	if len(lines) > m.height && m.height > 0 {
		keep := min(3, m.height)
		lines = append(lines[:m.height-keep], lines[len(lines)-keep:]...)
	}
	for i, line := range lines {
		lines[i] = ansi.Truncate(line, max(1, m.width), "…")
	}
	return lipgloss.JoinVertical(lipgloss.Left, lines...)
}

func (m Model) rule() string { return strings.Repeat("─", max(1, m.width)) }
func (m Model) pair(left, right string) string {
	return left + strings.Repeat(" ", max(1, m.width-lipgloss.Width(left)-lipgloss.Width(right))) + right
}
func (m Model) label(name, value string) string {
	return m.look.Tone(style.Strong, fmt.Sprintf("%-12s", name)) + value
}
func (m Model) readTime() string {
	if !m.readAt.IsZero() {
		return m.readAt.Format("15:04:05")
	}
	if m.now.IsZero() {
		return "--:--:--"
	}
	return m.now.Format("15:04:05")
}

func (m Model) listView() []string {
	running := 0
	for _, row := range m.machine.Ships {
		if row.Session.Status == "running" {
			running++
		}
	}
	lines := []string{m.pair(m.look.Tone(style.Strong, "aeolus-trierarch"), fmt.Sprintf("%d ships, %d sessions running", len(m.machine.Ships), running)), m.rule()}
	rows := [][]string{{"SHIP", "STATE", "HARNESS", "TURN", "ACTIVITY", "INBOX", "RESTARTS"}}
	for _, row := range m.machine.Ships {
		turn := "-"
		if t := row.Session.Turn; t != nil {
			turn = t.State + " " + elapsed(m.now, t.Since)
		}
		inbox := "not seen yet"
		if row.Inbox != nil {
			inbox = "not watched"
			if row.Inbox.IsWatched && row.Inbox.Inbox != nil {
				inbox = fmt.Sprint(row.Inbox.Waiting)
				if row.Inbox.Forced > 0 {
					inbox += fmt.Sprintf(", %d forced", row.Inbox.Forced)
				}
			}
		}
		if factFailure(row, "seen") != "" {
			turn, inbox = "unreadable", "unreadable"
		}
		active := activityText(row, m.now)
		if active == "none" {
			active = "-"
		}
		rows = append(rows, []string{clean(row.ShipName), row.State, row.Harness, turn, active, inbox, fmt.Sprint(row.Restarts)})
	}
	widths := make([]int, 7)
	for _, row := range rows {
		for col, cell := range row {
			widths[col] = max(widths[col], lipgloss.Width(cell))
		}
	}
	format := func(row []string, isHeader bool) string {
		cells := make([]string, len(row))
		for col, cell := range row {
			cells[col] = cell + strings.Repeat(" ", max(0, widths[col]-lipgloss.Width(cell)))
			if isHeader {
				cells[col] = m.look.Tone(style.Strong, cells[col])
			} else if col == 1 {
				cells[col] = m.look.Tone(style.OfState(cell), cells[col])
			}
		}
		return strings.TrimRight(strings.Join(cells, "  "), " ")
	}
	lines = append(lines, "  "+format(rows[0], true))
	visible := max(1, m.height-7)
	start := max(0, m.selected-visible+1)
	for i := start; i < min(len(m.machine.Ships), start+visible); i++ {
		mark := "  "
		if i == m.selected {
			mark = "> "
		}
		lines = append(lines, mark+format(rows[i+1], false))
	}
	if len(m.machine.Ships) == 0 {
		lines = append(lines, "No ship is crewed here.")
	}
	pass := "no pass yet"
	if m.machine.PassAt != "" {
		pass = "pass " + elapsed(m.now, m.machine.PassAt) + " ago"
	}
	lines = append(lines, m.rule(), m.pair("up/down move   enter open   e last end   q quit", "read "+m.readTime()+", "+pass), "To act on a ship: a forced message, Restart or Edit… in the console")
	return lines
}

func (m Model) shipView() []string {
	v := m.ship
	lines := []string{m.pair(m.look.Tone(style.Strong, "aeolus-trierarch > "+clean(v.ShipName)), "read "+m.readTime()), m.rule()}
	place := "on the host"
	if v.IsContainer {
		place = "in a container"
	}
	turn, inbox := observationText(v, m.now)
	lines = append(lines, m.label("Ship", fmt.Sprintf("%s (%s), %s, %s", clean(v.ShipName), v.ShipID, v.Harness, place)), m.label("State", fmt.Sprintf("%s since %s, %d restarts", m.look.Tone(style.OfState(v.State), v.State), clock(v.Since), v.Restarts)), m.label("Turn", turn), m.label("Activity", activityText(v, m.now)), m.label("Inbox", inbox))
	processFailure := factFailure(v, "processes")
	if processFailure == "" {
		processFailure = factFailure(v, "masking")
	}
	switch {
	case processFailure != "":
		lines = append(lines, m.label("Processes", processFailure))
	case len(v.Session.Processes) == 0:
		lines = append(lines, m.label("Processes", "none"))
	default:
		for i, p := range v.Session.Processes {
			label := ""
			if i == 0 {
				label = "Processes"
			}
			lines = append(lines, m.label(label, fmt.Sprintf("pid %d  %s  %s", p.PID, elapsed(m.now, p.StartedAt), clean(p.Command))))
		}
	}
	lines = append(lines, m.label("Last end", lastEndText(v)))
	places := [][2]string{{"ship folder", v.Places.ShipFolder}, {"main", v.Places.Main}}
	names := make([]string, 0, len(v.Places.SubRepositories))
	for name := range v.Places.SubRepositories {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		places = append(places, [2]string{name, v.Places.SubRepositories[name]})
	}
	places = append(places, [2]string{"home", v.Places.Home}, [2]string{"socket", v.Places.Socket}, [2]string{"hold", v.Places.Hold}, [2]string{"events", v.Places.Events})
	for i, p := range places {
		if p[1] == "" {
			continue
		}
		label := ""
		if i == 0 {
			label = "Places"
		}
		lines = append(lines, m.label(label, fmt.Sprintf("%-12s %s", clean(p[0]), clean(p[1]))))
	}
	for _, u := range v.Unreadable {
		if u.Fact != "seen" && u.Fact != "activity" && u.Fact != "processes" && u.Fact != "masking" {
			lines = append(lines, m.label("Unreadable", clean(u.Path+": "+u.Error)))
		}
	}
	lines = append(lines, m.rule(), m.pair("Last lines of events.jsonl", "up/down scroll"))
	failure := factFailure(v, "masking")
	if failure == "" {
		failure = factFailure(v, "activity")
	}
	return m.withLines(lines, v.Lines, failure, []string{"esc back   e last end   q quit", "To act on " + clean(v.ShipName) + ": a forced message, Restart or Edit… in the console"})
}

func (m Model) withLines(lines []string, events []shipview.Line, failure string, footer []string) []string {
	// Keep the lines and footer usable when the terminal cannot fit all places.
	if budget := m.height - len(footer) - 4; len(lines) > budget && budget >= 2 {
		heading := lines[len(lines)-1]
		lines = append(lines[:budget], m.rule(), heading)
	}
	available := max(1, m.height-len(lines)-len(footer)-1)
	if failure != "" {
		lines = append(lines, failure)
	} else if len(events) == 0 {
		lines = append(lines, "none")
	} else {
		start := min(m.offset, max(0, len(events)-available))
		for _, line := range events[start:min(len(events), start+available)] {
			prefix := clock(line.At)
			if line.Kind != "" {
				prefix += "  " + clean(line.Kind)
			}
			if line.Tool != "" {
				prefix += "  " + clean(line.Tool)
			}
			lines = append(lines, prefix+"  "+clean(line.Line))
		}
	}
	lines = append(lines, m.rule())
	return append(lines, footer...)
}

func activityText(v shipview.View, now time.Time) string {
	if failure := factFailure(v, "activity"); failure != "" {
		return failure
	}
	a := v.Session.Activity
	if a == nil {
		return "none"
	}
	text := clean(a.Kind)
	if a.Tool != "" {
		text += " " + clean(a.Tool)
	}
	return text + ", " + elapsed(now, a.At) + " ago"
}
func observationText(v shipview.View, now time.Time) (string, string) {
	if failure := factFailure(v, "seen"); failure != "" {
		return failure, failure
	}
	turn, inbox := "unknown", "not seen yet"
	if v.Session.Status != "running" {
		turn = "-"
	}
	if t := v.Session.Turn; t != nil {
		turn = clean(t.State)
		if t.Since != "" {
			turn += " since " + clock(t.Since) + " (" + elapsed(now, t.Since) + ")"
		}
		turn += ", seen " + elapsed(now, t.SeenAt) + " ago"
	}
	if v.Inbox != nil {
		inbox = "not watched while no session runs"
		if v.Inbox.IsWatched && v.Inbox.Inbox != nil {
			inbox = fmt.Sprintf("%d waiting, %d forced, seen %s ago", v.Inbox.Waiting, v.Inbox.Forced, elapsed(now, v.Inbox.SeenAt))
		}
	}
	return turn, inbox
}
func factFailure(v shipview.View, fact string) string {
	for _, u := range v.Unreadable {
		if u.Fact == fact {
			if fact == "masking" {
				return "not shown: cannot read " + clean(u.Path) + " to mask it (" + clean(u.Error) + ")"
			}
			return "unreadable: " + clean(u.Path+": "+u.Error)
		}
	}
	return ""
}
func clock(text string) string {
	if t, err := time.Parse(time.RFC3339Nano, text); err == nil {
		return t.Format("15:04:05")
	}
	return "--:--:--"
}
func elapsed(now time.Time, text string) string {
	t, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return "unknown"
	}
	return age(now.Sub(t))
}
func age(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", max(0, int(d.Round(time.Second)/time.Second)))
	}
	return fmt.Sprintf("%dm", int(d.Round(time.Minute)/time.Minute))
}
func clean(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, ansi.Strip(text))
}

func lastEndText(v shipview.View) string {
	if failure := factFailure(v, "last end"); failure != "" {
		return failure
	}
	if v.LastEnd == nil {
		return "none kept: no session of this ship ended since it was crewed here"
	}
	return clock(v.LastEnd.EndedAt) + ", " + clean(v.LastEnd.ExitReason) + " (e to read it)"
}

func (m Model) endView() []string {
	v := m.ship
	lines := []string{m.pair(m.look.Tone(style.Strong, "aeolus-trierarch > "+clean(v.ShipName)+" > last end"), "read "+m.readTime()), m.rule()}
	footer := []string{"esc back   q quit"}
	if v.LastEnd == nil || factFailure(v, "last end") != "" {
		return append(append(lines, m.label("Last end", lastEndText(v)), m.rule()), footer...)
	}
	e := v.LastEnd
	duration := "unknown"
	start, errStart := time.Parse(time.RFC3339Nano, e.StartedAt)
	end, errEnd := time.Parse(time.RFC3339Nano, e.EndedAt)
	if errStart == nil && errEnd == nil {
		d := max(time.Duration(0), end.Sub(start)).Round(time.Second)
		duration = fmt.Sprintf("%dm %ds", int(d/time.Minute), int(d%time.Minute/time.Second))
	}
	active := "none"
	if a := e.Activity; a != nil {
		active = clean(a.Kind)
		if a.Tool != "" {
			active += " " + clean(a.Tool)
		}
		active += ", at " + clock(a.At)
	}
	lines = append(lines, m.label("Ended", clock(e.EndedAt)+", "+clean(e.ExitReason)+", after running "+duration), m.label("Session", clean(e.Harness)+", session "+clean(e.SessionID)), m.label("Activity", active), m.label("Kept until", "the next session of "+clean(v.ShipName)+" ends, or its folder goes"), m.rule(), m.pair("Its last lines", "up/down scroll"))
	events := make([]shipview.Line, 0, len(e.Lines))
	for _, line := range e.Lines {
		events = append(events, shipview.Line(line))
	}
	return m.withLines(lines, events, clean(e.LinesError), footer)
}
