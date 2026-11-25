package guard

import (
	"path"
	"slices"
	"strings"
)

func isHarness(name string) bool {
	switch name {
	case "codex", "claude", "copilot", "cursor-agent", "agent":
		return true
	default:
		return false
	}
}

// interpreterSwitches are leading options that consume no argument and
// cannot by themselves select an interactive interpreter. An option with
// unknown arity cannot establish that a subsequent word is a script.
var interpreterSwitches = map[string][]string{
	"python":  {"-B", "-E", "-I", "-O", "-OO", "-P", "-q", "-s", "-S", "-u", "-v"},
	"node":    {"--no-warnings", "--trace-warnings", "--enable-source-maps", "--experimental-strip-types"},
	"nodejs":  {"--no-warnings", "--trace-warnings", "--enable-source-maps", "--experimental-strip-types"},
	"ruby":    {"-w", "-v"},
	"perl":    {"-w", "-W", "-T", "-t"},
	"php":     {"-n", "-q"},
	"Rscript": {"--vanilla", "--verbose", "--default-packages=NULL"},
}

func hasInterpreterProgram(name string, codeFlags []string, args []word) bool {
	for index, arg := range args {
		if !arg.literal || stdinScript(arg.text) || arg.text == "-i" || arg.text == "--interactive" {
			return false
		}
		option, _, inline := strings.Cut(arg.text, "=")
		if slices.Contains(codeFlags, option) || (name == "python" && option == "-m") {
			return inline || index+1 < len(args) && args[index+1].literal
		}
		if arg.text == "--" {
			return index+1 < len(args) && args[index+1].literal && !stdinScript(args[index+1].text)
		}
		if !strings.HasPrefix(arg.text, "-") {
			return arg.text != ""
		}
		if !slices.Contains(interpreterSwitches[name], arg.text) {
			return false
		}
	}
	return false
}

// stdinScript recognizes explicit names for the input stream.
func stdinScript(name string) bool {
	switch path.Clean(name) {
	case "-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0":
		return true
	default:
		return false
	}
}
