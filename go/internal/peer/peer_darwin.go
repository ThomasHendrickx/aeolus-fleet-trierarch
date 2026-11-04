package peer

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

const (
	// solLocal and localPeerPID are SOL_LOCAL and LOCAL_PEERPID of <sys/un.h>, which the syscall package does not name.
	solLocal     = 0
	localPeerPID = 0x002
)

// peerPID is the process that connected the socket, as LOCAL_PEERPID says it.
func peerPID(fd int) int {
	pid, err := syscall.GetsockoptInt(fd, solLocal, localPeerPID)
	if err != nil {
		return 0
	}
	return pid
}

// parentOf is the process's parent as ps names it; 0 when it is gone.
func parentOf(pid int) int {
	shown, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	parent, err := strconv.Atoi(strings.TrimSpace(string(shown)))
	if err != nil {
		return 0
	}
	return parent
}
