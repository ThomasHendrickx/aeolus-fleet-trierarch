package cli

import (
	"context"
	"os"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipview"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/style"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/tui"
	"golang.org/x/term"
)

func live(at paths.Paths, machine Machine, look style.Style) (answer, error) {
	inputTerminal := term.IsTerminal(int(os.Stdin.Fd()))
	if machine.IsInputTerminal != nil {
		inputTerminal = machine.IsInputTerminal()
	}
	if !machine.IsTerminal || !inputTerminal {
		return answer{text: "tui needs a terminal: read one ship with aeolus-trierarch status <ship> --json", code: 2}, nil
	}
	if machine.RunTUI != nil {
		return answer{}, machine.RunTUI(at, look)
	}
	return answer{}, tui.Run(context.Background(), localViews{at: at, machine: machine}, look)
}

type localViews struct {
	at      paths.Paths
	machine Machine
}

func (v localViews) Read(ctx context.Context, ship string, now time.Time) (shipview.Machine, shipview.View, error) {
	machine, err := (shipview.Reader{}).List(ctx, v.at, now)
	if err != nil {
		return machine, shipview.View{}, err
	}
	standing, unreadable := localStanding(v.at, v.machine, now)
	machine.Trierarch = standing
	machine.Unreadable = append(machine.Unreadable, unreadable...)
	for i := range machine.Ships {
		machine.Ships[i].Trierarch = standing
	}
	if ship == "" {
		return machine, shipview.View{}, nil
	}
	opened, err := (shipview.Reader{}).Ship(ctx, v.at, ship, now)
	opened.Trierarch = standing
	opened.Unreadable = append(opened.Unreadable, unreadable...)
	return machine, opened, err
}
