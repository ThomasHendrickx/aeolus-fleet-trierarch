package main

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// openPseudoTerminal opens a pseudo-terminal: its controlling side and the path of the terminal a process reads.
func openPseudoTerminal() (*os.File, string, error) {
	controller, err := os.OpenFile("/dev/ptmx", os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		return nil, "", err
	}
	if err := unix.IoctlSetPointerInt(int(controller.Fd()), unix.TIOCSPTLCK, 0); err != nil {
		controller.Close()
		return nil, "", err
	}
	number, err := unix.IoctlGetInt(int(controller.Fd()), unix.TIOCGPTN)
	if err != nil {
		controller.Close()
		return nil, "", err
	}
	return controller, fmt.Sprintf("/dev/pts/%d", number), nil
}
