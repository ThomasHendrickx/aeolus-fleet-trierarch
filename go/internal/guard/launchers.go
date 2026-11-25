package guard

import (
	"path"
	"strings"
)

// packageLauncher reads the package, executable or shell command a package manager is asked to run.
func (a *analyzer) packageLauncher(c runCall) {
	isLaunch := c.name == "npx" || c.name == "bunx"
	hasCommand := false
	for i := 0; i < len(c.args); i++ {
		arg := c.args[i]
		if !arg.literal {
			a.out.cannotResolve("package launcher target")
			return
		}
		option, value, inline := strings.Cut(arg.text, "=")
		switch option {
		case "-h", "--help", "-v", "--version":
			return
		case "-y", "--yes", "--no", "--no-install", "--silent", "-s", "--quiet", "-q", "--bun", "--verbose":
			continue
		case "-p", "--package", "-c", "--call":
			if !inline && i+1 < len(c.args) && c.args[i+1].literal {
				i++
				value = c.args[i].text
			}
			if value == "" {
				a.out.cannotResolve("package launcher target")
				return
			}
			if option == "-c" || option == "--call" {
				a.script(value, c.name+" command", c.state.copy())
				hasCommand = true
			} else {
				a.checkHarnessPackage(value)
			}
			continue
		case "--":
			continue
		}
		if strings.HasPrefix(arg.text, "-") {
			a.out.cannotResolve("package launcher option " + arg.text)
			return
		}
		if isLaunch {
			a.checkHarnessPackage(arg.text)
			return
		}
		if !launchSubcommand(c.name, arg.text) {
			return
		}
		isLaunch = true
	}
	if isLaunch && !hasCommand {
		a.out.cannotResolve("package launcher target")
	}
}

func launchSubcommand(manager, command string) bool {
	switch manager {
	case "npm":
		return command == "exec" || command == "x" || command == "ex"
	case "pnpm", "yarn":
		return command == "dlx" || command == "exec"
	case "bun":
		return command == "x" || command == "bunx"
	}
	return false
}

func (a *analyzer) checkHarnessPackage(spec string) {
	// The first @ of a scoped package is part of its name.
	name, _, _ := strings.Cut(strings.TrimPrefix(spec, "@"), "@")
	base := path.Base(name)
	a.out.launchesHarness = a.out.launchesHarness || isHarness(base) || base == "claude-code"
}
