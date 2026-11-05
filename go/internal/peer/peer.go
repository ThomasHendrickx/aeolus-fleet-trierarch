// Package peer tells who called a Unix socket (decision 0026, headless H9):
// the process at the other end of a connection, as the kernel says it made
// the connection, and whether it runs under one of the given processes. A
// caller that does not resolve is under nothing, so a check built on it
// refuses rather than allows.
package peer

import (
	"net"
	"slices"
)

// mostAncestors is deeper than any real process tree: a walk that goes on longer is not trusted.
const mostAncestors = 4096

// PID is the process at the other end of the connection, 0 when it does not resolve.
func PID(connection net.Conn) int {
	unix, ok := connection.(*net.UnixConn)
	if !ok {
		return 0
	}
	raw, err := unix.SyscallConn()
	if err != nil {
		return 0
	}
	pid := 0
	if err := raw.Control(func(fd uintptr) { pid = peerPID(int(fd)) }); err != nil {
		return 0
	}
	return pid
}

// IsInSessionOf is whether the process is in the process session (setsid) of one of the roots. A process keeps its session when its parent ends and it is reparented, as it keeps it when it forks, so this holds where IsUnder no longer does. A process whose session does not resolve is in every session, so a check built on it refuses rather than allows; a root whose session does not resolve is in none.
func IsInSessionOf(pid int, roots []int) bool {
	session := sessionOf(pid)
	if session <= 0 {
		return true
	}
	for _, root := range roots {
		if sessionOf(root) == session {
			return true
		}
	}
	return false
}

// IsUnder is whether the process is one of the roots or descends from one.
func IsUnder(pid int, roots []int) bool {
	current := pid
	for step := 0; current > 1 && step < mostAncestors; step++ {
		if slices.Contains(roots, current) {
			return true
		}
		current = parentOf(current)
	}
	return false
}
