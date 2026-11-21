package tui

import (
	"context"
	"fmt"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/style"
	tea "github.com/charmbracelet/bubbletea"
)

// Run owns the full-screen terminal until the person quits or its context ends.
func Run(ctx context.Context, source Source, look style.Style) error {
	_, err := tea.NewProgram(New(source, look), tea.WithAltScreen(), tea.WithContext(ctx)).Run()
	if err != nil {
		return fmt.Errorf("run live mode: %w", err)
	}
	return nil
}
