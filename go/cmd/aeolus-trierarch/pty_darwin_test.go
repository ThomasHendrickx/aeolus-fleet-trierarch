package main

import (
	"bytes"
	"os"
	"unsafe"

	"golang.org/x/sys/unix"
)

// openPseudoTerminal opens a pseudo-terminal: its controlling side and the path of the terminal a process reads.
func openPseudoTerminal() (*os.File, string, error) {
	controller, err := os.OpenFile("/dev/ptmx", os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		return nil, "", err
	}
	for _, request := range []uint{unix.TIOCPTYGRANT, unix.TIOCPTYUNLK} {
		if err := unix.IoctlSetInt(int(controller.Fd()), request, 0); err != nil {
			controller.Close()
			return nil, "", err
		}
	}
	name := make([]byte, 128)
	//lint:ignore SA1019 x/sys has no wrapper for TIOCPTYGNAME, which writes the terminal's name into a buffer.
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, controller.Fd(), uintptr(unix.TIOCPTYGNAME), uintptr(unsafe.Pointer(&name[0]))); errno != 0 {
		controller.Close()
		return nil, "", errno
	}
	return controller, string(name[:bytes.IndexByte(name, 0)]), nil
}
