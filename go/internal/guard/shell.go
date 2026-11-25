package guard

import (
	"errors"
	"maps"
	"path"
	"reflect"
	"regexp"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// maxNesting bounds how deep shell input inside shell input is read again.
const maxNesting = 16

// errUnparsable is shell input the parser refuses.
var errUnparsable = errors.New("shell input unparsable")

// word is one shell word: its value when it is literal, as written always.
type word struct {
	text    string
	literal bool
	source  string
	// expanded is the word with the variables the shell knows put in, as a
	// path; known is whether that could be done. glob says it holds an
	// unquoted glob.
	expanded string
	known    bool
	glob     bool
}

// invocation is one simple command the shell input runs, wrappers included.
type invocation struct {
	name  string
	args  []word
	env   map[string]word
	state *state
}

// analysis is everything the shell input runs and what of it cannot be
// resolved before it runs.
type analysis struct {
	invocations     []invocation
	launchesHarness bool
	unresolvable    []string
	writes          []writeTarget
	// links are the symbolic links the input makes, by absolute path.
	links map[string]string
}

func (a *analysis) cannotResolve(what string) {
	a.unresolvable = append(a.unresolvable, what)
}

// state is what the shell knows at a point of the input: its working folder
// ("" when it cannot be known) and the variables set to literal values.
type state struct {
	cwd  string
	vars map[string]string
	// gitEnv are the GIT_* variables set, literal or not: git reads them.
	gitEnv map[string]word
}

func newState(cwd, home string) *state {
	return &state{cwd: cwd, vars: map[string]string{"HOME": home}, gitEnv: map[string]word{}}
}

func (s *state) copy() *state {
	return &state{cwd: s.cwd, vars: maps.Clone(s.vars), gitEnv: maps.Clone(s.gitEnv)}
}

// merge keeps what both paths through the input agree on.
func (s *state) merge(other *state) {
	if s.cwd != other.cwd {
		s.cwd = ""
	}
	for name, value := range s.vars {
		if other.vars[name] != value {
			delete(s.vars, name)
		}
	}
	// A GIT_* variable either path sets may be set.
	maps.Copy(s.gitEnv, other.gitEnv)
}

// analyzer reads shell input into its analysis.
type analyzer struct {
	home  string
	out   *analysis
	depth int
}

func parseShell(source string) (*syntax.File, error) {
	file, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(strings.NewReader(source), "")
	if err != nil {
		return nil, errors.Join(errUnparsable, err)
	}
	return file, nil
}

// analyzeShell reads the shell input of a call run in cwd.
func analyzeShell(source, cwd, home string) (*analysis, error) {
	file, err := parseShell(source)
	if err != nil {
		return nil, err
	}
	a := &analyzer{home: home, out: &analysis{links: map[string]string{}}}
	a.stmts(file.Stmts, newState(cwd, home))
	return a.out, nil
}

// script reads literal shell input found inside the input, as sh -c, eval,
// an alias or a trap carry it.
func (a *analyzer) script(source, what string, st *state) {
	if a.depth >= maxNesting {
		a.out.cannotResolve(what + " nested too deep")
		return
	}
	file, err := parseShell(source)
	if err != nil {
		a.out.cannotResolve(what + " unparsable")
		return
	}
	a.depth++
	a.stmts(file.Stmts, st)
	a.depth--
}

func (a *analyzer) stmts(list []*syntax.Stmt, st *state) {
	for _, s := range list {
		a.stmt(s, st, false)
	}
}

// stmt reads one statement; piped says its stdin comes from a pipe.
func (a *analyzer) stmt(s *syntax.Stmt, st *state, piped bool) {
	var stdin *syntax.Redirect
	for _, redirect := range s.Redirs {
		a.substitutions(redirect.Word, st)
		a.substitutions(redirect.Hdoc, st)
		switch redirect.Op {
		case syntax.Hdoc, syntax.DashHdoc, syntax.WordHdoc, syntax.RdrIn:
			stdin = redirect
		case syntax.RdrOut, syntax.AppOut, syntax.RdrClob, syntax.RdrInOut, syntax.RdrAll, syntax.AppAll:
			a.write(a.word(redirect.Word, st), st, false)
		case syntax.DplOut:
			if target := a.word(redirect.Word, st); !target.literal || !isFileDescriptor(target.text) {
				a.write(target, st, false)
			}
		}
	}
	input := shellInput{redirect: stdin, piped: piped}
	switch cmd := s.Cmd.(type) {
	case nil:
	case *syntax.CallExpr:
		a.call(cmd, st, input)
	case *syntax.BinaryCmd:
		a.binary(cmd, st)
	case *syntax.Subshell:
		a.stmts(cmd.Stmts, st.copy())
	case *syntax.Block:
		a.stmts(cmd.Stmts, st)
	case *syntax.IfClause:
		a.ifClause(cmd, st)
	case *syntax.WhileClause:
		branch := st.copy()
		a.stmts(cmd.Cond, branch)
		a.stmts(cmd.Do, branch)
		st.merge(branch)
	case *syntax.ForClause:
		branch := st.copy()
		a.substitutions(cmd.Loop, branch)
		if iter, ok := cmd.Loop.(*syntax.WordIter); ok {
			delete(branch.vars, iter.Name.Value)
		}
		a.stmts(cmd.Do, branch)
		st.merge(branch)
	case *syntax.CaseClause:
		a.substitutions(cmd.Word, st)
		for _, item := range cmd.Items {
			branch := st.copy()
			for _, pattern := range item.Patterns {
				a.substitutions(pattern, branch)
			}
			a.stmts(item.Stmts, branch)
			st.merge(branch)
		}
	case *syntax.FuncDecl:
		// The body may run at any point after this: read it as it stands here.
		a.stmt(cmd.Body, st.copy(), false)
	case *syntax.DeclClause:
		a.declaration(cmd, st)
	case *syntax.TimeClause:
		if cmd.Stmt != nil {
			a.stmt(cmd.Stmt, st, piped)
		}
	case *syntax.CoprocClause:
		a.stmt(cmd.Stmt, st.copy(), false)
	case *syntax.ArithmCmd, *syntax.TestClause, *syntax.LetClause:
		a.substitutions(cmd, st)
	default:
		a.out.cannotResolve("shell construct " + source(cmd))
	}
}

func (a *analyzer) binary(cmd *syntax.BinaryCmd, st *state) {
	switch cmd.Op {
	case syntax.Pipe, syntax.PipeAll:
		// Each side of a pipeline runs in a subshell of its own.
		a.stmt(cmd.X, st.copy(), false)
		a.stmt(cmd.Y, st.copy(), true)
	default:
		a.stmt(cmd.X, st, false)
		branch := st.copy()
		a.stmt(cmd.Y, branch, false)
		st.merge(branch)
	}
}

func (a *analyzer) ifClause(cmd *syntax.IfClause, st *state) {
	a.stmts(cmd.Cond, st)
	branch := st.copy()
	a.stmts(cmd.Then, branch)
	other := st.copy()
	if cmd.Else != nil {
		a.ifClause(cmd.Else, other)
	}
	branch.merge(other)
	st.cwd, st.vars = branch.cwd, branch.vars
}

// substitutions reads the commands a node runs through command and process
// substitution, each in a subshell of its own.
func (a *analyzer) substitutions(node syntax.Node, st *state) {
	// A nil *syntax.Word or *syntax.ArrayExpr arrives as a non-nil interface.
	if node == nil || reflect.ValueOf(node).IsNil() {
		return
	}
	syntax.Walk(node, func(n syntax.Node) bool {
		switch sub := n.(type) {
		case *syntax.CmdSubst:
			a.stmts(sub.Stmts, st.copy())
			return false
		case *syntax.ProcSubst:
			a.stmts(sub.Stmts, st.copy())
			return false
		}
		return true
	})
}

func (a *analyzer) assign(assign *syntax.Assign, st *state, env map[string]word) {
	a.substitutions(assign.Value, st)
	a.substitutions(assign.Array, st)
	if assign.Name == nil {
		return
	}
	name := assign.Name.Value
	value := word{literal: assign.Value == nil, source: name}
	if assign.Value != nil {
		value = a.word(assign.Value, st)
	}
	if assign.Array != nil || assign.Index != nil || assign.Append {
		value.literal = false
	}
	if env != nil {
		env[name] = value
		return
	}
	if strings.HasPrefix(name, "GIT_") {
		st.gitEnv[name] = value
	}
	if value.literal {
		st.vars[name] = value.text
	} else {
		delete(st.vars, name)
	}
}

func (a *analyzer) declaration(cmd *syntax.DeclClause, st *state) {
	var args []word
	for _, assign := range cmd.Args {
		if assign.Naked && assign.Name == nil {
			args = append(args, a.word(assign.Value, st))
			a.substitutions(assign.Value, st)
			continue
		}
		a.assign(assign, st, nil)
		args = append(args, word{text: assign.Name.Value, literal: true, source: assign.Name.Value})
	}
	a.out.invocations = append(a.out.invocations, invocation{name: cmd.Variant.Value, args: args, state: st.copy()})
}

// shellInput is where a command's stdin comes from.
type shellInput struct {
	redirect *syntax.Redirect
	piped    bool
}

func (a *analyzer) call(cmd *syntax.CallExpr, st *state, input shellInput) {
	for _, arg := range cmd.Args {
		a.substitutions(arg, st)
	}
	if len(cmd.Args) == 0 {
		for _, assign := range cmd.Assigns {
			a.assign(assign, st, nil)
		}
		return
	}
	env := map[string]word{}
	for _, assign := range cmd.Assigns {
		a.assign(assign, st, env)
	}
	words := make([]word, len(cmd.Args))
	for index, arg := range cmd.Args {
		words[index] = a.word(arg, st)
	}
	a.simple(words, env, st, input)
}

// simple reads one simple command: its name, then what it runs in turn.
func (a *analyzer) simple(words []word, env map[string]word, st *state, input shellInput) {
	if len(words) == 0 {
		return
	}
	name := words[0]
	if !name.literal {
		a.out.cannotResolve("command name " + name.source)
		return
	}
	base := path.Base(name.text)
	args := words[1:]
	a.out.invocations = append(a.out.invocations, invocation{name: base, args: args, env: env, state: st.copy()})
	if writes, ok := writers[base]; ok {
		writes(a, args, st)
	}
	if run, ok := runners[base]; ok {
		run(a, runCall{name: base, args: args, env: env, state: st, input: input})
		return
	}
	if isShell(base) {
		a.shell(base, args, st, input)
		return
	}
	if flags, ok := interpreters[interpreterName(base)]; ok {
		before := len(a.out.unresolvable)
		a.interpreter(base, flags, args)
		if len(a.out.unresolvable) == before && !hasInterpreterProgram(interpreterName(base), flags, args) {
			a.out.cannotResolve("reads commands from stdin")
		}
	}
}

// runCall is a command that runs other commands or changes the shell's state.
type runCall struct {
	name  string
	args  []word
	env   map[string]word
	state *state
	input shellInput
}

var runners map[string]func(a *analyzer, c runCall)

func init() {
	runners = map[string]func(a *analyzer, c runCall){
		"cd":      (*analyzer).cd,
		"pushd":   (*analyzer).cd,
		"popd":    func(_ *analyzer, c runCall) { c.state.cwd = "" },
		"eval":    (*analyzer).eval,
		"source":  (*analyzer).source,
		".":       (*analyzer).source,
		"alias":   (*analyzer).alias,
		"trap":    (*analyzer).trap,
		"env":     (*analyzer).env,
		"command": (*analyzer).command,
		"builtin": func(a *analyzer, c runCall) { a.simple(c.args, c.env, c.state, c.input) },
		"exec":    wrapper(options{"-c": 0, "-l": 0, "-a": 1}),
		"nohup":   wrapper(options{}),
		"time":    wrapper(options{"-p": 0}),
		"setsid":  wrapper(options{"-c": 0, "-f": 0, "-w": 0}),
		"stdbuf":  wrapper(options{"-i": 1, "-o": 1, "-e": 1}),
		"nice":    wrapper(options{"-n": 1}),
		"sudo": wrapper(options{
			"-u": 1, "-g": 1, "-h": 1, "-p": 1, "-C": 1, "-T": 1, "-r": 1, "-t": 1, "-U": 1, "-D": 1,
			"-E": 0, "-H": 0, "-n": 0, "-S": 0, "-b": 0, "-k": 0, "-A": 0, "-P": 0,
		}),
		"doas":        wrapper(options{"-u": 1, "-n": 0}),
		"timeout":     (*analyzer).timeout,
		"xargs":       (*analyzer).xargs,
		"find":        (*analyzer).find,
		"watch":       (*analyzer).watch,
		"git":         (*analyzer).git,
		"npx":         (*analyzer).packageLauncher,
		"npm":         (*analyzer).packageLauncher,
		"bunx":        (*analyzer).packageLauncher,
		"bun":         (*analyzer).packageLauncher,
		"pnpm":        (*analyzer).packageLauncher,
		"yarn":        (*analyzer).packageLauncher,
		"corepack":    wrapper(options{}),
		"busybox":     (*analyzer).busybox,
		"script":      (*analyzer).terminal,
		"tmux":        (*analyzer).terminal,
		"screen":      (*analyzer).terminal,
		"apply_patch": (*analyzer).patch,
	}
}

// git reads the shell command a git !alias runs.
func (a *analyzer) git(c runCall) {
	read := readGit(invocation{name: c.name, args: c.args, env: c.env, state: c.state})
	if read.shellAlias != "" {
		a.script(read.shellAlias, "git alias", c.state.copy())
	}
}

func (a *analyzer) cd(c runCall) {
	operands := skipOptions(c.args, options{"-L": 0, "-P": 0, "-e": 0, "-@": 0})
	if len(operands) == 0 {
		c.state.cwd = a.home
		return
	}
	target := operands[0]
	if !target.literal || target.text == "-" || strings.HasPrefix(target.text, "+") {
		c.state.cwd = ""
		return
	}
	if path.IsAbs(target.text) {
		c.state.cwd = path.Clean(target.text)
		return
	}
	if c.state.cwd != "" {
		c.state.cwd = path.Join(c.state.cwd, target.text)
	}
}

func (a *analyzer) eval(c runCall) {
	texts := make([]string, 0, len(c.args))
	for _, arg := range c.args {
		if !arg.literal {
			a.out.cannotResolve("eval of " + sources(c.args))
			return
		}
		texts = append(texts, arg.text)
	}
	a.script(strings.Join(texts, " "), "eval", c.state)
}

func (a *analyzer) source(c runCall) {
	// A literal file is a script that runs as a program: the guard checks the
	// call, not the program (design 4.6).
	if len(c.args) == 0 || !c.args[0].literal {
		a.out.cannotResolve(c.name + " of " + sources(c.args))
	}
}

func (a *analyzer) alias(c runCall) {
	for _, arg := range c.args {
		if !arg.literal {
			a.out.cannotResolve("alias " + arg.source)
			continue
		}
		if _, value, ok := strings.Cut(arg.text, "="); ok {
			a.script(value, "alias", c.state.copy())
		}
	}
}

func (a *analyzer) trap(c runCall) {
	if len(c.args) == 0 || strings.HasPrefix(c.args[0].text, "-") && c.args[0].literal {
		return
	}
	action := c.args[0]
	if !action.literal {
		a.out.cannotResolve("trap of " + action.source)
		return
	}
	a.script(action.text, "trap", c.state.copy())
}

func (a *analyzer) env(c runCall) {
	env := maps.Clone(c.env)
	args := c.args
	for len(args) > 0 {
		arg := args[0]
		switch {
		case !arg.literal:
			a.out.cannotResolve("env argument " + arg.source)
			return
		case arg.text == "--":
			args = args[1:]
			a.simple(args, env, c.state, c.input)
			return
		case arg.text == "-i" || arg.text == "--ignore-environment" || arg.text == "-0" || arg.text == "-v":
			args = args[1:]
		case arg.text == "-u" || arg.text == "--unset":
			args = args[min(2, len(args)):]
		case arg.text == "-C" || arg.text == "--chdir":
			if len(args) < 2 {
				return
			}
			dir := c.state.copy()
			a.cd(runCall{args: args[1:2], state: dir})
			a.simple(args[2:], env, dir, c.input)
			return
		case arg.text == "-S" || arg.text == "--split-string":
			if len(args) < 2 {
				return
			}
			rest := sources(args[2:])
			if !args[1].literal {
				a.out.cannotResolve("env -S of " + args[1].source)
				return
			}
			a.script(strings.TrimSpace(args[1].text+" "+rest), "env -S", c.state.copy())
			return
		case strings.HasPrefix(arg.text, "-"):
			a.out.cannotResolve("env option " + arg.text)
			return
		case strings.Contains(arg.text, "="):
			name, value, _ := strings.Cut(arg.text, "=")
			env[name] = word{text: value, literal: true, source: arg.source}
			args = args[1:]
		default:
			a.simple(args, env, c.state, c.input)
			return
		}
	}
}

func (a *analyzer) command(c runCall) {
	args := c.args
	for len(args) > 0 && args[0].literal && strings.HasPrefix(args[0].text, "-") {
		if args[0].text == "--" {
			args = args[1:]
			break
		}
		if strings.ContainsAny(args[0].text, "vV") {
			return
		}
		args = args[1:]
	}
	a.simple(args, c.env, c.state, c.input)
}

// options are a command's options and how many values each takes.
type options map[string]int

// wrapper reads a command that runs the command after its options.
func wrapper(known options) func(a *analyzer, c runCall) {
	return func(a *analyzer, c runCall) {
		rest, ok := a.afterOptions(c.name, c.args, known)
		if ok {
			a.simple(rest, c.env, c.state, c.input)
		}
	}
}

// afterOptions drops the leading options of a wrapper; false when one cannot
// be read, which is unresolvable.
func (a *analyzer) afterOptions(name string, args []word, known options) ([]word, bool) {
	for len(args) > 0 {
		arg := args[0]
		if !arg.literal {
			return args, true
		}
		if arg.text == "--" {
			return args[1:], true
		}
		if !strings.HasPrefix(arg.text, "-") || arg.text == "-" {
			return args, true
		}
		if values, found := known[arg.text]; found {
			args = args[min(1+values, len(args)):]
			continue
		}
		if values, found := known[arg.text[:2]]; found && !strings.HasPrefix(arg.text, "--") {
			// A value attached to its option, as in -oL or -n5.
			if values == 0 {
				a.out.cannotResolve(name + " option " + arg.text)
				return nil, false
			}
			args = args[1:]
			continue
		}
		if name == "nice" && isNumber(arg.text[1:]) {
			args = args[1:]
			continue
		}
		a.out.cannotResolve(name + " option " + arg.text)
		return nil, false
	}
	return args, true
}

func (a *analyzer) timeout(c runCall) {
	rest, ok := a.afterOptions(c.name, c.args, options{
		"-s": 1, "--signal": 1, "-k": 1, "--kill-after": 1, "-v": 0, "--verbose": 0,
		"--foreground": 0, "--preserve-status": 0,
	})
	if !ok || len(rest) == 0 {
		return
	}
	a.simple(rest[1:], c.env, c.state, c.input)
}

func (a *analyzer) xargs(c runCall) {
	rest, ok := a.afterOptions(c.name, c.args, options{
		"-I": 1, "-L": 1, "-n": 1, "-P": 1, "-s": 1, "-d": 1, "-E": 1, "-a": 1,
		"-0": 0, "-r": 0, "-t": 0, "-p": 0, "-x": 0, "-o": 0,
		"--null": 0, "--no-run-if-empty": 0, "--verbose": 0, "--interactive": 0, "--exit": 0, "--open-tty": 0,
	})
	if !ok {
		return
	}
	// Options attached to their value or given as --name=value.
	for len(rest) > 0 && rest[0].literal && strings.HasPrefix(rest[0].text, "-") {
		rest = rest[1:]
	}
	if len(rest) == 0 {
		return
	}
	if !rest[0].literal {
		a.out.cannotResolve("xargs running " + rest[0].source)
		return
	}
	a.simple(rest, c.env, c.state.copy(), shellInput{piped: true})
}

func (a *analyzer) find(c runCall) {
	args := c.args
	for index := 0; index < len(args); index++ {
		switch args[index].text {
		case "-exec", "-execdir", "-ok", "-okdir":
		default:
			continue
		}
		action := args[index].text
		end := index + 1
		for end < len(args) && args[end].text != ";" && args[end].text != "+" {
			end++
		}
		command := args[index+1 : end]
		if len(command) > 0 && !command[0].literal {
			a.out.cannotResolve("find " + action + " running " + command[0].source)
			return
		}
		a.simple(command, c.env, c.state.copy(), shellInput{})
		index = end
	}
}

func (a *analyzer) watch(c runCall) {
	rest, ok := a.afterOptions(c.name, c.args, options{
		"-n": 1, "--interval": 1, "-d": 0, "--differences": 0, "-t": 0, "--no-title": 0,
		"-b": 0, "--beep": 0, "-e": 0, "--errexit": 0, "-g": 0, "--chgexit": 0, "-c": 0, "--color": 0,
	})
	if !ok || len(rest) == 0 {
		return
	}
	texts := make([]string, 0, len(rest))
	for _, arg := range rest {
		if !arg.literal {
			a.out.cannotResolve("watch running " + arg.source)
			return
		}
		texts = append(texts, arg.text)
	}
	// watch hands its words to sh -c.
	a.script(strings.Join(texts, " "), "watch", c.state.copy())
}

var shells = map[string]bool{
	"sh": true, "bash": true, "dash": true, "zsh": true, "ksh": true, "mksh": true,
	"ash": true, "rbash": true, "fish": true, "csh": true, "tcsh": true, "hush": true,
}

func isShell(name string) bool { return shells[name] }

func (a *analyzer) busybox(c runCall) {
	if len(c.args) == 0 {
		return
	}
	applet := c.args[0]
	if !applet.literal {
		a.out.cannotResolve("busybox applet " + applet.source)
		return
	}
	if name := path.Base(applet.text); isShell(name) {
		a.shell(name, c.args[1:], c.state, c.input)
	}
}

func (a *analyzer) terminal(runCall) {
	// These programs can start or attach to a terminal with its own input.
	a.out.cannotResolve("reads commands from stdin")
}

// shell reads a shell run as a command: its -c string, or its script from
// stdin; a script file runs as a program.
func (a *analyzer) shell(name string, args []word, st *state, input shellInput) {
	command, fromStdin := false, false
	var fishHasCommand bool
	for len(args) > 0 {
		arg := args[0]
		if !arg.literal {
			break
		}
		if arg.text == "--" || arg.text == "-" {
			args = args[1:]
			break
		}
		if arg.text == "-o" || arg.text == "+o" || arg.text == "-O" || arg.text == "+O" ||
			arg.text == "--rcfile" || arg.text == "--init-file" {
			args = args[min(2, len(args)):]
			continue
		}
		if arg.text == "--interactive" {
			a.out.cannotResolve("reads commands from stdin")
			return
		}
		if name == "fish" {
			option, text, inline := strings.Cut(arg.text, "=")
			switch option {
			case "-c", "--command", "-C", "--init-command":
				args = args[1:]
				if !inline {
					if len(args) == 0 || !args[0].literal {
						a.out.cannotResolve("fish command of " + sources(args[:min(1, len(args))]))
						return
					}
					text, args = args[0].text, args[1:]
				}
				a.script(text, "fish "+option, st.copy())
				fishHasCommand = fishHasCommand || option == "-c" || option == "--command"
				continue
			}
		}
		if strings.HasPrefix(arg.text, "--") {
			args = args[1:]
			continue
		}
		if !strings.HasPrefix(arg.text, "-") && !strings.HasPrefix(arg.text, "+") {
			break
		}
		if strings.HasPrefix(arg.text, "-") && strings.Contains(arg.text, "i") {
			a.out.cannotResolve("reads commands from stdin")
			return
		}
		if strings.HasPrefix(arg.text, "-") && strings.Contains(arg.text, "c") {
			command = true
		}
		if strings.HasPrefix(arg.text, "-") && strings.Contains(arg.text, "s") {
			fromStdin = true
		}
		args = args[1:]
	}
	switch {
	case command:
		if len(args) == 0 || !args[0].literal {
			a.out.cannotResolve(name + " -c of " + sources(args[:min(1, len(args))]))
			return
		}
		a.script(args[0].text, name+" -c", st.copy())
	case fishHasCommand:
		return
	case len(args) > 0 && !fromStdin:
		if args[0].literal && stdinScript(args[0].text) {
			a.out.cannotResolve("reads commands from stdin")
		}
		if !args[0].literal {
			a.out.cannotResolve(name + " script " + args[0].source)
		}
	default:
		text, ok := a.literalStdin(input)
		if !ok {
			if input.redirect == nil && !input.piped {
				a.out.cannotResolve("reads commands from stdin")
				return
			}
			a.out.cannotResolve(name + " script from stdin")
			return
		}
		a.script(text, name+" script", st.copy())
	}
}

// literalStdin is a command's stdin when it is literal: a here string or a
// here document whose body nothing expands.
func (a *analyzer) literalStdin(input shellInput) (string, bool) {
	redirect := input.redirect
	if input.piped || redirect == nil {
		return "", false
	}
	switch redirect.Op {
	case syntax.WordHdoc:
		value := a.word(redirect.Word, newState("", a.home))
		return value.text, value.literal
	case syntax.Hdoc, syntax.DashHdoc:
		if redirect.Hdoc == nil {
			return "", true
		}
		var body strings.Builder
		for _, part := range redirect.Hdoc.Parts {
			lit, ok := part.(*syntax.Lit)
			if !ok {
				return "", false
			}
			body.WriteString(lit.Value)
		}
		if quotedDelimiter(redirect.Word) {
			return body.String(), true
		}
		if strings.ContainsRune(body.String(), '\\') {
			return "", false
		}
		return body.String(), true
	}
	return "", false
}

func quotedDelimiter(delimiter *syntax.Word) bool {
	for _, part := range delimiter.Parts {
		switch p := part.(type) {
		case *syntax.SglQuoted, *syntax.DblQuoted:
			return true
		case *syntax.Lit:
			if strings.ContainsRune(p.Value, '\\') {
				return true
			}
		}
	}
	return false
}

// interpreters are the programs that run code given on their command line,
// with the options that carry it.
var interpreters = map[string][]string{
	"python":  {"-c"},
	"node":    {"-e", "--eval", "-p", "--print"},
	"nodejs":  {"-e", "--eval", "-p", "--print"},
	"perl":    {"-e", "-E"},
	"ruby":    {"-e"},
	"php":     {"-r"},
	"lua":     {"-e"},
	"Rscript": {"-e"},
}

// interpreterName is python for python3 and python3.12, the name otherwise.
func interpreterName(name string) string {
	if strings.HasPrefix(name, "python") && strings.Trim(name[len("python"):], "0123456789.") == "" {
		return "python"
	}
	return name
}

// interpreter refuses code an interpreter is given that is built at run
// time. Literal code runs: the guard checks the call, not the program.
func (a *analyzer) interpreter(name string, flags []string, args []word) {
	for index, arg := range args {
		for _, flag := range flags {
			switch {
			case arg.literal && arg.text == flag:
				if index+1 < len(args) && !args[index+1].literal {
					a.out.cannotResolve(name + " " + flag + " of " + args[index+1].source)
				}
			case strings.HasPrefix(arg.source, flag) && !arg.literal:
				a.out.cannotResolve(name + " " + flag + " of " + arg.source)
			}
		}
	}
}

// skipOptions drops leading options a command knows.
func skipOptions(args []word, known options) []word {
	for len(args) > 0 && args[0].literal {
		if args[0].text == "--" {
			return args[1:]
		}
		values, found := known[args[0].text]
		if !found {
			return args
		}
		args = args[min(1+values, len(args)):]
	}
	return args
}

func isNumber(text string) bool {
	return text != "" && strings.Trim(text, "0123456789") == ""
}

func sources(words []word) string {
	texts := make([]string, len(words))
	for index, w := range words {
		texts[index] = w.source
	}
	return strings.Join(texts, " ")
}

func source(node syntax.Node) string {
	var out strings.Builder
	if err := syntax.NewPrinter().Print(&out, node); err != nil {
		return "?"
	}
	return strings.TrimSpace(out.String())
}

// word reads a shell word: literal when nothing in it is known only at run
// time (expansions, substitutions, globs, brace expansion, ~user).
func (a *analyzer) word(w *syntax.Word, st *state) word {
	result := word{source: source(w), literal: true, known: true}
	var text, expanded strings.Builder
	for index, part := range w.Parts {
		switch p := part.(type) {
		case *syntax.Lit:
			value := p.Value
			if index == 0 && strings.HasPrefix(value, "~") {
				rest := value[1:]
				if rest != "" && !strings.HasPrefix(rest, "/") {
					result.literal, result.known = false, false
				}
				value = a.home + rest
			}
			if braceExpansion(value) {
				result.literal, result.known = false, false
			}
			if strings.ContainsAny(stripEscaped(value), "*?[") {
				result.literal, result.glob = false, true
			}
			text.WriteString(unescape(value, false))
			expanded.WriteString(unescape(value, false))
		case *syntax.SglQuoted:
			if p.Dollar && strings.ContainsRune(p.Value, '\\') {
				result.literal, result.known = false, false
			}
			text.WriteString(p.Value)
			expanded.WriteString(p.Value)
		case *syntax.DblQuoted:
			for _, inner := range p.Parts {
				if lit, ok := inner.(*syntax.Lit); ok {
					text.WriteString(unescape(lit.Value, true))
					expanded.WriteString(unescape(lit.Value, true))
					continue
				}
				result.literal = false
				value, ok := st.variable(inner)
				if !ok {
					result.known = false
				}
				expanded.WriteString(value)
			}
		default:
			result.literal = false
			value, ok := st.variable(part)
			if !ok || strings.ContainsAny(value, " \t\n*?[") {
				result.known = false
			}
			expanded.WriteString(value)
		}
	}
	if result.literal {
		result.text = text.String()
	}
	if result.known {
		result.expanded = expanded.String()
	}
	return result
}

// simpleParameter is $NAME or ${NAME}, nothing more.
var simpleParameter = regexp.MustCompile(`^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$`)

// variable is the value of $NAME when the shell knows it.
func (s *state) variable(part syntax.WordPart) (string, bool) {
	param, ok := part.(*syntax.ParamExp)
	if !ok || param.Param == nil || !simpleParameter.MatchString(source(param)) {
		return "", false
	}
	value, ok := s.vars[param.Param.Value]
	return value, ok
}

// braceExpansion is an unquoted literal the shell expands as {a,b} or {1..3}.
func braceExpansion(value string) bool {
	clean := unescape(value, false)
	open := strings.IndexByte(clean, '{')
	if open < 0 {
		return false
	}
	inner := clean[open:]
	return strings.Contains(inner, "}") && (strings.Contains(inner, ",") || strings.Contains(inner, ".."))
}

// stripEscaped drops the characters a backslash escapes.
func stripEscaped(value string) string {
	var out strings.Builder
	for index := 0; index < len(value); index++ {
		if value[index] == '\\' {
			index++
			continue
		}
		out.WriteByte(value[index])
	}
	return out.String()
}

// unescape removes the backslashes the shell removes: before any character
// unquoted, before $ ` " \ and a newline inside double quotes.
func unescape(value string, quoted bool) string {
	if !strings.ContainsRune(value, '\\') {
		return value
	}
	var out strings.Builder
	for index := 0; index < len(value); index++ {
		c := value[index]
		if c != '\\' || index+1 == len(value) {
			out.WriteByte(c)
			continue
		}
		next := value[index+1]
		switch {
		case next == '\n':
			index++
		case !quoted || strings.IndexByte("$`\"\\", next) >= 0:
			out.WriteByte(next)
			index++
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}
