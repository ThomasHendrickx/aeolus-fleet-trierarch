package peer

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// peerPID is the process that connected the socket, as SO_PEERCRED says it, in this process's pid namespace.
func peerPID(fd int) int {
	credentials, err := syscall.GetsockoptUcred(fd, syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	if err != nil {
		return 0
	}
	return int(credentials.Pid)
}

// parentOf is the process's parent from its stat line, whose name may hold spaces and parentheses: the fields after its last `)`; 0 when it is gone.
func parentOf(pid int) int {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0
	}
	text := string(stat)
	fields := strings.Fields(text[strings.LastIndex(text, ")")+1:])
	if len(fields) < 2 {
		return 0
	}
	parent, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0
	}
	return parent
}
