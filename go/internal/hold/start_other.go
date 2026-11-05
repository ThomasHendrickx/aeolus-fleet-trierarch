//go:build !linux

package hold

import (
	"os/exec"
	"strconv"
	"strings"
)

// startOf is when the process started, as ps says it: none when it is gone. A group id is the pid of its leader, so a group is the same one while its leader is the process that started at the same time.
func startOf(pid int) string {
	started, err := exec.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.Join(strings.Fields(string(started)), "_")
}
