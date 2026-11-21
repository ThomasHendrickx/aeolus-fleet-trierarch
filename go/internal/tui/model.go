package tui

import (
	"context"
	"errors"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipview"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/style"
	tea "github.com/charmbracelet/bubbletea"
)

const refreshEvery = 5 * time.Second

// Source reads local facts for the list or an opened ship. An unknown ship still returns the list.
type Source interface {
	Read(context.Context, string, time.Time) (shipview.Machine, shipview.View, error)
}

type tickMsg time.Time
type readMsg struct {
	machine shipview.Machine
	ship    shipview.View
	err     error
	request uint64
}

// New opens the ship list. No file is read until Init's command runs.
func New(source Source, look style.Style) Model {
	return Model{source: source, look: look, width: 100, height: 30, now: time.Now()}
}

// Init reads the first screen and starts the fixed five-second refresh.
func (m Model) Init() tea.Cmd { return tea.Batch(m.load(), nextTick()) }
func nextTick() tea.Cmd {
	return tea.Tick(refreshEvery, func(now time.Time) tea.Msg { return tickMsg(now) })
}
func (m Model) load() tea.Cmd {
	return func() tea.Msg {
		if m.source == nil {
			return readMsg{request: m.request}
		}
		id := ""
		if m.screen != listScreen {
			id = m.ship.ShipID
		}
		ctx, cancel := context.WithTimeout(context.Background(), refreshEvery)
		defer cancel()
		machine, ship, err := m.source.Read(ctx, id, m.now)
		return readMsg{machine: machine, ship: ship, err: err, request: m.request}
	}
}

// Update handles navigation and reads only; no key acts on a ship.
func (m Model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		m.width = max(1, msg.Width)
		m.height = max(1, msg.Height)
	case tickMsg:
		if m.readAt.IsZero() {
			m.readAt = m.now
		}
		m.now = time.Time(msg)
		m.request++
		return m, tea.Batch(m.load(), nextTick())
	case readMsg:
		if msg.request != m.request {
			return m, nil
		}
		if errors.Is(msg.err, shipview.ErrShipUnknown) && m.screen != listScreen {
			m.hasRead = true
			m.readAt = m.now
			m.notice = m.ship.ShipName + " is no longer crewed here"
			m.screen = listScreen
			m.offset = 0
			m.machine = msg.machine
			m.selected = 0
			m.failure = ""
			return m, nil
		}
		if msg.err != nil {
			m.failure = msg.err.Error()
			return m, nil
		}
		id := ""
		if len(m.machine.Ships) > m.selected {
			id = m.machine.Ships[m.selected].ShipID
		}
		m.machine = msg.machine
		m.hasRead = true
		m.readAt = m.now
		m.failure = ""
		m.selected = min(m.selected, max(0, len(m.machine.Ships)-1))
		for i, row := range m.machine.Ships {
			if row.ShipID == id {
				m.selected = i
				break
			}
		}
		if m.screen != listScreen {
			m.ship = msg.ship
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "esc":
			m.request++
			m.offset = 0
			m.notice = ""
			if m.screen == endScreen && m.from == shipScreen {
				m.screen = shipScreen
			} else {
				m.screen = listScreen
			}
		case "up", "k", "down", "j":
			delta := 1
			if msg.String() == "up" || msg.String() == "k" {
				delta = -1
			}
			if m.screen == listScreen {
				m.selected = max(0, min(max(0, len(m.machine.Ships)-1), m.selected+delta))
			} else {
				m.offset = max(0, min(max(0, len(m.ship.Lines)-m.linePageSize()), m.offset+delta))
			}
		case "enter", "e":
			if m.screen == endScreen || (msg.String() == "enter" && m.screen != listScreen) {
				break
			}
			if m.screen == listScreen {
				if len(m.machine.Ships) == 0 {
					break
				}
				m.ship = m.machine.Ships[m.selected]
			}
			m.from = m.screen
			m.screen = shipScreen
			if msg.String() == "e" {
				m.screen = endScreen
			}
			m.offset = 0
			m.notice = ""
			m.request++
			return m, m.load()
		}
	}
	return m, nil
}

func (m Model) linePageSize() int {
	// The fixed part of the ship screen includes the footer and the lines' heading.
	copy := m
	copy.ship.Lines = nil
	copy.offset = 0
	return max(1, m.height-len(copy.shipView())+1)
}
