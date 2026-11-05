package hold

import (
	"os"
	"strconv"
	"strings"
)

// startOf is when the process started, as its stat line says it in clock ticks since boot: none when it is gone. A group id is the pid of its leader, so a group is the same one while its leader is the process that started at the same time. The stat line's name may hold spaces and parentheses: the fields are those after its last `)`.
func startOf(pid int) string {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return ""
	}
	text := string(stat)
	fields := strings.Fields(text[strings.LastIndex(text, ")")+1:])
	if len(fields) < 20 {
		return ""
	}
	return fields[19]
}
