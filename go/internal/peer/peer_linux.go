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

// parentOf is the process's parent from its stat line; 0 when it is gone.
func parentOf(pid int) int {
	return statField(pid, 1)
}

// sessionOf is the process's session from its stat line; 0 when it is gone.
func sessionOf(pid int) int {
	return statField(pid, 3)
}

// statField is the number at that place among the fields of the process's stat line after its name, which may hold spaces and parentheses: the fields after its last `)`, from its state; 0 when the process is gone.
func statField(pid int, place int) int {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0
	}
	text := string(stat)
	fields := strings.Fields(text[strings.LastIndex(text, ")")+1:])
	if len(fields) <= place {
		return 0
	}
	value, err := strconv.Atoi(fields[place])
	if err != nil {
		return 0
	}
	return value
}
