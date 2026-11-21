package tui

import (
	"context"
	"errors"
	"fmt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/ended"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipview"
	tea "github.com/charmbracelet/bubbletea"
)

// localFacts stands in for file reads, not another model.
type localFacts struct {
	machine shipview.Machine
	ship    shipview.View
	err     error
}

func (f *localFacts) Read(_ context.Context, _ string, _ time.Time) (shipview.Machine, shipview.View, error) {
	return f.machine, f.ship, f.err
}
func press(t *testing.T, m Model, key string) (Model, tea.Cmd) {
	t.Helper()
	message := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(key)}
	switch key {
	case "enter":
		message = tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		message = tea.KeyMsg{Type: tea.KeyEsc}
	case "up":
		message = tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		message = tea.KeyMsg{Type: tea.KeyDown}
	}
	next, cmd := m.Update(message)
	return next.(Model), cmd
}
func readResult(t *testing.T, m Model, cmd tea.Cmd) Model {
	t.Helper()
	if cmd == nil {
		t.Fatal("read command = nil, want local read")
	}
	msg := cmd()
	if batch, ok := msg.(tea.BatchMsg); ok {
		msg = batch[0]()
	}
	next, _ := m.Update(msg)
	return next.(Model)
}

func TestKeysMoveOpenGoBackAndQuitWithoutActingOnAShip(t *testing.T) {
	for _, key := range []string{"down", "j"} {
		t.Run(key, func(t *testing.T) {
			m := aScreen()
			m, _ = press(t, m, key)
			if m.selected != 1 {
				t.Fatalf("Update(%s) selected = %d, want 1", key, m.selected)
			}
			m, _ = press(t, m, "k")
			if m.selected != 0 {
				t.Fatalf("Update(k) selected = %d, want 0", m.selected)
			}
		})
	}
	for _, key := range []string{"enter", "e"} {
		t.Run(key, func(t *testing.T) {
			m := aScreen()
			m.source = &localFacts{machine: m.machine, ship: m.ship}
			next, cmd := press(t, m, key)
			next = readResult(t, next, cmd)
			want := shipScreen
			if key == "e" {
				want = endScreen
			}
			if next.screen != want {
				t.Fatalf("Update(%s) screen = %v, want %v", key, next.screen, want)
			}
			next, _ = press(t, next, "esc")
			if next.screen != listScreen {
				t.Fatalf("Update(esc from %s) = %v, want list", key, next.screen)
			}
		})
	}
	m := aScreen()
	_, cmd := press(t, m, "q")
	if cmd == nil {
		t.Fatal("Update(q) = nil, want quit")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatalf("Update(q) command = %T, want QuitMsg", cmd())
	}
}

func TestSelectionStopsAtTheListBoundaries(t *testing.T) {
	m := aScreen()
	m, _ = press(t, m, "up")
	if m.selected != 0 {
		t.Fatalf("Update(up at first) = %d, want 0", m.selected)
	}
	for range 10 {
		m, _ = press(t, m, "down")
	}
	if m.selected != 4 {
		t.Fatalf("Update(down at last) = %d, want 4", m.selected)
	}
	m.machine.Ships = nil
	for _, key := range []string{"up", "down", "enter", "e"} {
		m, _ = press(t, m, key)
	}
	if m.screen != listScreen || m.selected != 0 {
		t.Fatalf("Update(empty) = screen %v, row %d, want list, 0", m.screen, m.selected)
	}
}

func TestShipLinesScrollWithinTheVisiblePage(t *testing.T) {
	m := aScreen()
	m.screen = shipScreen
	m.height = 25
	m.ship.Lines = nil
	for range 200 {
		m.ship.Lines = append(m.ship.Lines, shipview.Line{Line: "line"})
	}
	for range 250 {
		m, _ = press(t, m, "j")
	}
	if m.offset <= 0 || m.offset >= 200 {
		t.Fatalf("Update(250 scrolls) offset = %d, want inside 200 lines", m.offset)
	}
	for range 250 {
		m, _ = press(t, m, "up")
	}
	if m.offset != 0 {
		t.Fatalf("Update(scroll above first) offset = %d, want 0", m.offset)
	}
}

func TestTickReloadsFactsAndKeepsSelectionByShipID(t *testing.T) {
	m := aScreen()
	m.selected = 1
	changed := m.machine
	changed.Ships = []shipview.View{m.machine.Ships[1], m.machine.Ships[0]}
	m.source = &localFacts{machine: changed}
	next, cmd := m.Update(tickMsg(m.now.Add(5 * time.Second)))
	m = readResult(t, next.(Model), cmd)
	if m.selected != 0 || len(m.machine.Ships) != 2 {
		t.Fatalf("Update(tick reordered ships) selected = %d, rows = %d, want 0, 2", m.selected, len(m.machine.Ships))
	}
	if refreshEvery != 5*time.Second {
		t.Fatalf("refresh interval = %s, want 5s", refreshEvery)
	}
}

func TestAnOpenedShipThatLeavesReturnsToTheList(t *testing.T) {
	m := aScreen()
	m.screen = shipScreen
	m.source = &localFacts{machine: shipview.Machine{}, err: shipview.ErrShipUnknown}
	next, cmd := m.Update(tickMsg(m.now))
	m = readResult(t, next.(Model), cmd)
	if m.screen != listScreen || !strings.Contains(m.View(), "design-tri-271c is no longer crewed here") {
		t.Fatalf("Update(removed ship) = %s, want list and removed-ship notice", m.View())
	}
}

func TestAReadFailureKeepsTheLastFactsAndRetriesOnTheNextTick(t *testing.T) {
	m := aScreen()
	facts := &localFacts{err: errors.New("cannot read state")}
	m.source = facts
	next, cmd := m.Update(tickMsg(m.now))
	m = readResult(t, next.(Model), cmd)
	if !strings.Contains(m.View(), "cannot read state") || len(m.machine.Ships) != 5 {
		t.Fatalf("Update(read failure) = %s, want error and last five rows", m.View())
	}
	facts.err = nil
	facts.machine = m.machine
	next, cmd = m.Update(tickMsg(m.now))
	m = readResult(t, next.(Model), cmd)
	if m.failure != "" {
		t.Fatalf("Update(read recovered) error = %q, want empty", m.failure)
	}
}

func TestOldReadCannotReplaceFactsAfterNavigatingBack(t *testing.T) {
	m := aScreen()
	m.source = &localFacts{machine: m.machine, ship: m.ship}
	opening, cmd := press(t, m, "enter")
	opening, _ = press(t, opening, "esc")
	opening = readResult(t, opening, cmd)
	if opening.screen != listScreen {
		t.Fatalf("Update(late read after esc) = %v, want list", opening.screen)
	}
}

func TestWindowResizeChangesTheViewWidth(t *testing.T) {
	m := aScreen()
	next, _ := m.Update(tea.WindowSizeMsg{Width: 50, Height: 20})
	m = next.(Model)
	if m.width != 50 || m.height != 20 {
		t.Fatalf("Update(resize) = %dx%d, want 50x20", m.width, m.height)
	}
}

func TestAReadFailureKeepsTheLastReadTime(t *testing.T) {
	m := aScreen()
	m.source = &localFacts{err: errors.New("cannot read state")}
	next, cmd := m.Update(tickMsg(m.now.Add(time.Minute)))
	m = readResult(t, next.(Model), cmd)
	if got := m.View(); !strings.Contains(got, "read 14:02:31") {
		t.Fatalf("View(failed read at 14:03:31) = %s, want read 14:02:31", got)
	}
}

func TestOpeningAShipShowsLoadingBeforeItsFactsArrive(t *testing.T) {
	m := aScreen()
	m.source = &localFacts{machine: m.machine, ship: m.ship}
	m, cmd := press(t, m, "enter")
	if got := m.View(); !strings.Contains(got, "Reading local ship facts…") || strings.Contains(got, "none kept") {
		t.Fatalf("View(opening ship) = %s, want loading without a premature no-end claim", got)
	}
	m = readResult(t, m, cmd)
	if got := m.View(); strings.Contains(got, "Reading local ship facts…") || !strings.Contains(got, "Processes") {
		t.Fatalf("View(opened ship) = %s, want its loaded facts", got)
	}
}

func TestLastEndScrollUsesKeptLinesInsteadOfCurrentLines(t *testing.T) {
	m := aScreen()
	m.screen = endScreen
	m.height = 18
	m.ship.Lines = nil
	m.ship.LastEnd = &ended.End{}
	for i := range 200 {
		m.ship.LastEnd.Lines = append(m.ship.LastEnd.Lines, ended.Line{Line: fmt.Sprintf("kept line %d", i)})
	}
	for range 250 {
		m, _ = press(t, m, "j")
	}
	if got := m.View(); !strings.Contains(got, "kept line 199") {
		t.Fatalf("View(scrolled end) = %s, want final kept line", got)
	}
	m, _ = press(t, m, "esc")
	if m.screen != listScreen {
		t.Fatal("esc from end opened on list must return to list")
	}
}
