package guard

import (
	"strings"
)

// The git actions of 4.1, a closed list.
const (
	gitPush           = "push"
	gitForcePush      = "force-push"
	gitSkipHooks      = "skip-hooks"
	gitRewriteHistory = "rewrite-history"
	gitDeleteBranch   = "delete-branch"
	gitChangeRemote   = "change-remote"
	gitChangeConfig   = "change-config"
)

// gitActionOrder is the order a set's git rules are reported in.
var gitActionOrder = []string{gitPush, gitForcePush, gitSkipHooks, gitRewriteHistory, gitDeleteBranch, gitChangeRemote, gitChangeConfig}

// gitCommands are git's own commands, and filter-repo, which 4.1 names. Any
// other is an alias or a git-<name> program the guard cannot read.
var gitCommands = setOf(strings.Fields(`add am annotate apply archive bisect blame branch bundle cat-file
	check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick
	citool clean clone column commit commit-graph commit-tree config count-objects credential describe
	diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch
	filter-repo fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui
	hash-object help hook index-pack init instaweb interpret-trailers log ls-files ls-remote ls-tree
	mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mktag mktree
	multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push
	range-diff read-tree rebase reflog remote repack replace request-pull rerere reset restore rev-list
	rev-parse revert rm send-email send-pack shortlog show show-branch show-index show-ref
	sparse-checkout stage stash status stripspace submodule switch symbolic-ref tag unpack-file
	unpack-objects update-index update-ref update-server-info var verify-commit verify-pack verify-tag
	version whatchanged worktree write-tree`))

// gitActing are the commands whose words can make a denied action: a word
// in them that is not literal is unresolvable, unless it is an option's value.
var gitActing = setOf([]string{"push", "send-pack", "commit", "merge", "pull", "am", "rebase", "branch", "remote", "config", "reset", "update-ref"})

// gitValueOptions are options whose value is free text, never an action.
var gitValueOptions = setOf([]string{"-m", "--message", "-F", "--file", "--author", "--date", "-t", "--template", "-C", "-c", "--reuse-message", "--reedit-message"})

// gitGlobalValues are git's global options that take a value.
var gitGlobalValues = setOf([]string{"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--list-cmds", "--attr-source"})

// gitGlobalFlags are git's global options without a value.
var gitGlobalFlags = setOf(strings.Fields(`-p --paginate -P --no-pager --bare --no-replace-objects
	--literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-optional-locks
	--no-advice --version --help -h --html-path --man-path --info-path --exec-path`))

// gitEnvUnreadable are variables that point git at configuration or
// programs the guard cannot read.
var gitEnvUnreadable = setOf([]string{"GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_EXEC_PATH"})

func setOf(items []string) map[string]bool {
	set := make(map[string]bool, len(items))
	for _, item := range items {
		set[item] = true
	}
	return set
}

// gitCall is what one git command does, as far as the guard reads it.
type gitCall struct {
	actions map[string]bool
	// unresolvable is what keeps it from being read, "" when nothing does.
	unresolvable string
	// shellAlias is the shell command of a !alias it runs.
	shellAlias string
}

func (g *gitCall) act(action string) { g.actions[action] = true }

// readGit reads the git action a git command makes: its environment and
// global options first, then its command.
func readGit(run invocation) gitCall {
	result := gitCall{actions: map[string]bool{}}
	env := map[string]word{}
	if run.state != nil {
		for name, value := range run.state.gitEnv {
			env[name] = value
		}
	}
	for name, value := range run.env {
		env[name] = value
	}
	if what := result.readEnv(env); what != "" {
		result.unresolvable = what
		return result
	}
	aliases := map[string]string{}
	args := run.args
	for len(args) > 0 {
		arg := args[0]
		if !arg.literal || !strings.HasPrefix(arg.text, "-") {
			break
		}
		name, value, attached := strings.Cut(arg.text, "=")
		switch {
		case gitGlobalFlags[arg.text]:
			args = args[1:]
			continue
		case name == "--exec-path" && attached:
			result.unresolvable = "git " + arg.text
			return result
		case !gitGlobalValues[name] && !(strings.HasPrefix(arg.text, "-c") && len(arg.text) > 2) && !(strings.HasPrefix(arg.text, "-C") && len(arg.text) > 2):
			result.unresolvable = "git option " + arg.text
			return result
		}
		option := name
		switch {
		case strings.HasPrefix(arg.text, "-c") && len(arg.text) > 2:
			option, value, attached = "-c", arg.text[2:], true
		case strings.HasPrefix(arg.text, "-C") && len(arg.text) > 2:
			option, attached = "-C", true
		}
		if !attached {
			if len(args) < 2 {
				return result
			}
			if !args[1].literal {
				result.unresolvable = "argument " + args[1].source + " of git"
				return result
			}
			value = args[1].text
			args = args[1:]
		}
		args = args[1:]
		switch option {
		case "-c":
			key, setting, _ := strings.Cut(value, "=")
			result.readConfig(key, aliases, setting)
		case "--config-env":
			key, _, _ := strings.Cut(value, "=")
			if alias, ok := strings.CutPrefix(strings.ToLower(key), "alias."); ok {
				result.unresolvable = "git alias " + alias + " from the environment"
				return result
			}
			result.readConfig(key, nil, "")
		}
	}
	if len(args) == 0 {
		return result
	}
	if !args[0].literal {
		result.unresolvable = "git subcommand " + args[0].source
		return result
	}
	for range maxNesting {
		value, ok := aliases[args[0].text]
		if !ok {
			break
		}
		if shell, ok := strings.CutPrefix(value, "!"); ok {
			result.shellAlias = shell
			return result
		}
		words := literalWords(strings.Fields(value))
		if len(words) == 0 {
			break
		}
		args = append(words, args[1:]...)
	}
	command := args[0].text
	if !gitCommands[command] {
		result.unresolvable = "git " + command
		return result
	}
	result.readCommand(command, args[1:])
	return result
}

func literalWords(texts []string) []word {
	words := make([]word, len(texts))
	for index, text := range texts {
		words[index] = word{text: text, literal: true, source: text}
	}
	return words
}

// readEnv reads the GIT_* variables a git command runs with.
func (g *gitCall) readEnv(env map[string]word) string {
	for name, value := range env {
		described := value.source
		if !strings.HasPrefix(described, name+"=") {
			described = name + "=" + described
		}
		switch {
		case gitEnvUnreadable[name]:
			return described + " for git"
		case name == "GIT_CONFIG_PARAMETERS":
			if !value.literal {
				return described + " for git"
			}
			lower := strings.ToLower(value.text)
			if strings.Contains(lower, "alias.") {
				return described + " for git"
			}
			if strings.Contains(lower, "core.hookspath") {
				g.act(gitSkipHooks)
			}
		case strings.HasPrefix(name, "GIT_CONFIG_KEY_"):
			if !value.literal || strings.HasPrefix(strings.ToLower(value.text), "alias.") {
				return described + " for git"
			}
			g.readConfig(value.text, nil, "")
		}
	}
	return ""
}

// readConfig reads one configuration a git command runs with.
func (g *gitCall) readConfig(key string, aliases map[string]string, value string) {
	lower := strings.ToLower(key)
	if lower == "core.hookspath" {
		g.act(gitSkipHooks)
	}
	if alias, ok := strings.CutPrefix(lower, "alias."); ok && aliases != nil {
		aliases[alias] = value
	}
}

// gitWord is one word after the git command: an option or an operand.
type gitWord struct {
	word
	option bool
}

// gitWords splits a git command's words into options and operands. A word
// that is not literal and no option's value is unresolvable in a command
// that can make an action.
func (g *gitCall) gitWords(command string, args []word) []gitWord {
	words := make([]gitWord, 0, len(args))
	afterDashes := false
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if !arg.literal {
			previous := ""
			if index > 0 && args[index-1].literal {
				previous = args[index-1].text
			}
			if gitActing[command] && !afterDashes && !gitValueOptions[previous] && !attachedValue(arg.source) {
				g.unresolvable = "argument " + arg.source + " of git " + command
			}
			words = append(words, gitWord{word: arg})
			continue
		}
		if arg.text == "--" {
			afterDashes = true
			continue
		}
		isOption := !afterDashes && strings.HasPrefix(arg.text, "-") && arg.text != "-"
		words = append(words, gitWord{word: arg, option: isOption})
		if isOption && gitValueOptions[arg.text] && index+1 < len(args) {
			index++
			words = append(words, gitWord{word: args[index]})
		}
	}
	return words
}

// attachedValue is a word that is an option with its value attached, as
// -m"$MSG" or --message="$MSG".
func attachedValue(source string) bool {
	for option := range gitValueOptions {
		if strings.HasPrefix(source, option+"=") || (len(option) == 2 && strings.HasPrefix(source, option) && len(source) > 2) {
			return true
		}
	}
	return false
}

// longOption is whether arg is --name, or an abbreviation of it git accepts.
func longOption(arg, name string) bool {
	body, ok := strings.CutPrefix(arg, "--")
	if !ok {
		return false
	}
	body, _, _ = strings.Cut(body, "=")
	return body != "" && strings.HasPrefix(name, body)
}

// shortOption is whether arg holds the short option letter, alone or in a
// cluster, before any letter that takes a value.
func shortOption(arg string, letter byte, valued string) bool {
	if len(arg) < 2 || arg[0] != '-' || arg[1] == '-' {
		return false
	}
	for index := 1; index < len(arg); index++ {
		if arg[index] == letter {
			return true
		}
		if strings.IndexByte(valued, arg[index]) >= 0 {
			return false
		}
	}
	return false
}

func (g *gitCall) readCommand(command string, args []word) {
	// A word that cannot be resolved still leaves the actions the others make.
	words := g.gitWords(command, args)
	for _, w := range words {
		if w.option && longOption(w.text, "no-verify") {
			g.act(gitSkipHooks)
		}
	}
	switch command {
	case "push", "send-pack":
		g.readPush(words)
	case "commit":
		for _, w := range words {
			if w.option && shortOption(w.text, 'n', "mFCctS") {
				g.act(gitSkipHooks)
			}
			if w.option && longOption(w.text, "amend") {
				g.act(gitRewriteHistory)
			}
		}
	case "rebase", "filter-branch", "filter-repo":
		g.act(gitRewriteHistory)
	case "reset":
		for _, w := range words {
			if w.option && longOption(w.text, "hard") {
				g.act(gitRewriteHistory)
			}
		}
	case "branch":
		for _, w := range words {
			if w.option && (shortOption(w.text, 'd', "utf") || shortOption(w.text, 'D', "utf") || longOption(w.text, "delete")) {
				g.act(gitDeleteBranch)
			}
		}
	case "update-ref":
		for _, w := range words {
			if w.option && (w.text == "-d" || longOption(w.text, "delete")) {
				g.act(gitDeleteBranch)
			}
		}
	case "remote":
		if operands := gitOperands(words); len(operands) > 0 {
			switch operands[0].text {
			case "add", "set-url", "remove", "rm":
				g.act(gitChangeRemote)
			}
		}
	case "config":
		g.readConfigCommand(words)
	}
}

func (g *gitCall) readPush(words []gitWord) {
	g.act(gitPush)
	for _, w := range words {
		switch {
		case w.option && (longOption(w.text, "force") || longOption(w.text, "force-with-lease") || shortOption(w.text, 'f', "o")):
			g.act(gitForcePush)
		case w.option && (longOption(w.text, "delete") || shortOption(w.text, 'd', "o")):
			g.act(gitDeleteBranch)
		case !w.option && w.literal && strings.HasPrefix(w.text, "+"):
			g.act(gitForcePush)
			if strings.HasPrefix(w.text, "+:") {
				g.act(gitDeleteBranch)
			}
		case !w.option && w.literal && strings.HasPrefix(w.text, ":"):
			g.act(gitDeleteBranch)
		}
	}
}

func gitOperands(words []gitWord) []gitWord {
	var operands []gitWord
	for _, w := range words {
		if !w.option {
			operands = append(operands, w)
		}
	}
	return operands
}

// readConfigCommand reads git config: a write is change-config, and any
// use of core.hooksPath is skip-hooks.
func (g *gitCall) readConfigCommand(words []gitWord) {
	write, read := false, false
	var operands []gitWord
	for index := 0; index < len(words); index++ {
		w := words[index]
		if !w.option {
			operands = append(operands, w)
			continue
		}
		name, _, attached := strings.Cut(w.text, "=")
		switch name {
		case "--unset", "--unset-all", "--add", "--replace-all", "--rename-section", "--remove-section", "-e", "--edit":
			write = true
		case "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "-l", "--list", "--show-origin", "--show-scope":
			read = true
		case "-f", "--file", "--blob", "--type", "--default", "--comment", "--value":
			if !attached && index+1 < len(words) {
				index++
			}
		}
	}
	for _, operand := range operands {
		if strings.EqualFold(operand.text, "core.hooksPath") {
			g.act(gitSkipHooks)
		}
	}
	if len(operands) > 0 {
		switch operands[0].text {
		case "set", "unset", "rename-section", "remove-section", "edit":
			g.act(gitChangeConfig)
			return
		case "get", "list":
			return
		}
	}
	if write || (!read && len(operands) >= 2) {
		g.act(gitChangeConfig)
	}
}

// judgeGit checks the set's git rules against one git command.
func judgeGit(set *Set, run invocation) *verdict {
	denied := set.Rules.Git.Deny
	if len(denied) == 0 || run.name != "git" {
		return nil
	}
	read := readGit(run)
	for _, action := range gitActionOrder {
		if read.actions[action] && contains(denied, action) {
			return &verdict{rule: "git.deny " + action, set: set}
		}
	}
	if read.unresolvable != "" {
		return mechanism("unresolvable: " + read.unresolvable)
	}
	return nil
}

func contains(items []string, item string) bool {
	for _, candidate := range items {
		if candidate == item {
			return true
		}
	}
	return false
}
