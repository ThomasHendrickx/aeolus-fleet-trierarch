package guard

import (
	"path"
	"strings"
)

// writeTarget is a path a call writes: absolute and cleaned, or unresolvable.
type writeTarget struct {
	path string
	// recursive says the write reaches everything under path too.
	recursive bool
	// own says the write is to path itself, a link at path not followed.
	own bool
	// unresolvable says why path could not be known, "" when it is known.
	unresolvable string
}

// devices are the files a write to which changes nothing on disk.
var devices = setOf([]string{"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"})

func isFileDescriptor(text string) bool {
	return text == "-" || isNumber(strings.TrimSuffix(text, "-"))
}

// write records a write target the shell input names.
func (a *analyzer) write(w word, st *state, recursive bool) {
	a.writeTarget(w, st, writeTarget{recursive: recursive})
}

// writeOwn records a write to a path itself: a link there is not followed.
func (a *analyzer) writeOwn(w word, st *state, recursive bool) {
	a.writeTarget(w, st, writeTarget{recursive: recursive, own: true})
}

func (a *analyzer) writeTarget(w word, st *state, target writeTarget) {
	if !w.known {
		target.unresolvable = "write target " + w.source
		a.out.writes = append(a.out.writes, target)
		return
	}
	text := w.expanded
	if w.glob {
		// Whatever the glob matches lies under its folder.
		text, target.recursive = globFolder(text), true
	}
	if !path.IsAbs(text) {
		if st.cwd == "" {
			target.unresolvable = "write target " + w.source + " in an unknown working folder"
			a.out.writes = append(a.out.writes, target)
			return
		}
		text = path.Join(st.cwd, text)
	}
	target.path = path.Clean(text)
	if strings.HasPrefix(target.path, "/dev/fd/") || devices[target.path] {
		return
	}
	a.out.writes = append(a.out.writes, target)
}

// globFolder is the folder a glob's matches lie in: its segments before the
// first one that holds a glob.
func globFolder(text string) string {
	segments := strings.Split(text, "/")
	for index, segment := range segments {
		if strings.ContainsAny(segment, "*?[") {
			folder := strings.Join(segments[:index], "/")
			if folder == "" && strings.HasPrefix(text, "/") {
				return "/"
			}
			if folder == "" {
				return "."
			}
			return folder
		}
	}
	return text
}

// writers are the commands whose operands are write targets (design 4.6, step 4).
var writers = map[string]func(a *analyzer, args []word, st *state){
	"rm":    recursiveOperands(options{}),
	"rmdir": recursiveOperands(options{}),
	"touch": plainOperands(options{"-d": 1, "-r": 1, "-t": 1}),
	"mkdir": plainOperands(options{"-m": 1}),
	"tee":   plainOperands(options{}),
	"chmod": (*analyzer).chmod,
	"sed":   (*analyzer).sed,
	"cp":    copyLike(false),
	"mv":    copyLike(true),
	"ln":    (*analyzer).ln,
}

// operandsOf splits a command's words into its operands and its options,
// each option with its value when it takes one.
func operandsOf(args []word, known options) (operands []word, given map[string]word) {
	given = map[string]word{}
	afterDashes := false
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if afterDashes || !arg.literal || !strings.HasPrefix(arg.text, "-") || arg.text == "-" {
			operands = append(operands, arg)
			continue
		}
		if arg.text == "--" {
			afterDashes = true
			continue
		}
		name, value, attached := strings.Cut(arg.text, "=")
		if values, found := known[name]; found && values > 0 {
			switch {
			case attached:
				given[name] = word{text: value, literal: true, source: arg.source, expanded: value, known: true}
			case index+1 < len(args):
				index++
				given[name] = args[index]
			}
			continue
		}
		if len(arg.text) > 2 && !strings.HasPrefix(arg.text, "--") {
			if values, found := known[arg.text[:2]]; found && values > 0 {
				value := arg.text[2:]
				given[arg.text[:2]] = word{text: value, literal: true, source: arg.source, expanded: value, known: true}
				continue
			}
		}
		given[name] = arg
	}
	return operands, given
}

func recursiveOperands(known options) func(a *analyzer, args []word, st *state) {
	return func(a *analyzer, args []word, st *state) {
		operands, _ := operandsOf(args, known)
		for _, operand := range operands {
			a.writeOwn(operand, st, true)
		}
	}
}

func plainOperands(known options) func(a *analyzer, args []word, st *state) {
	return func(a *analyzer, args []word, st *state) {
		operands, _ := operandsOf(args, known)
		for _, operand := range operands {
			a.write(operand, st, false)
		}
	}
}

// chmodFlags are chmod's options; any other word starting with - is a mode.
var chmodFlags = setOf([]string{"-R", "-v", "-c", "-f", "-H", "-L", "-P", "--recursive", "--verbose", "--changes", "--silent", "--quiet"})

func (a *analyzer) chmod(args []word, st *state) {
	var operands []word
	reference := false
	for _, arg := range args {
		switch {
		case arg.literal && chmodFlags[arg.text]:
		case arg.literal && strings.HasPrefix(arg.text, "--reference"):
			reference = true
		default:
			operands = append(operands, arg)
		}
	}
	if !reference && len(operands) > 0 {
		operands = operands[1:]
	}
	for _, operand := range operands {
		a.write(operand, st, true)
	}
}

func (a *analyzer) sed(args []word, st *state) {
	operands, given := operandsOf(args, options{"-e": 1, "--expression": 1, "-f": 1, "--file": 1, "-l": 1, "--line-length": 1})
	inPlace := false
	for name := range given {
		if strings.HasPrefix(name, "--in-place") || (!strings.HasPrefix(name, "--") && strings.Contains(name, "i")) {
			inPlace = true
		}
	}
	if !inPlace {
		return
	}
	_, script := given["-e"]
	_, expression := given["--expression"]
	_, file := given["-f"]
	_, longFile := given["--file"]
	if !script && !expression && !file && !longFile && len(operands) > 0 {
		operands = operands[1:]
	}
	for _, operand := range operands {
		a.write(operand, st, false)
	}
}

// copyOptions are the options of cp, mv and ln that take a value.
var copyOptions = options{"-t": 1, "--target-directory": 1, "-S": 1, "--suffix": 1}

// copyTargets are the sources and the destination of cp, mv and ln. Each
// source lands at the destination, or in it when it is a folder.
// The destination is surely a folder when -t names it or it ends in /.
func copyTargets(args []word) (sources []word, destination word, folder bool, ok bool) {
	operands, given := operandsOf(args, copyOptions)
	if named, found := given["-t"]; found {
		return operands, named, true, true
	}
	if named, found := given["--target-directory"]; found {
		return operands, named, true, true
	}
	if len(operands) < 2 {
		return nil, word{}, false, false
	}
	destination = operands[len(operands)-1]
	return operands[:len(operands)-1], destination, strings.HasSuffix(destination.source, "/"), true
}

// into is the path a source lands at inside a destination folder.
func into(destination, source word) word {
	if !destination.known || !source.known {
		return destination
	}
	inside := destination
	inside.expanded = strings.TrimSuffix(destination.expanded, "/") + "/" + path.Base(source.expanded)
	return inside
}

func copyLike(moves bool) func(a *analyzer, args []word, st *state) {
	return func(a *analyzer, args []word, st *state) {
		sources, destination, folder, ok := copyTargets(args)
		if !ok {
			return
		}
		if !folder {
			a.write(destination, st, false)
		}
		for _, source := range sources {
			a.write(into(destination, source), st, false)
			if moves {
				a.writeOwn(source, st, true)
			}
		}
	}
}

func (a *analyzer) ln(args []word, st *state) {
	sources, destination, folder, ok := copyTargets(args)
	if !ok {
		if operands, _ := operandsOf(args, copyOptions); len(operands) == 1 {
			// ln <target> makes the link in the working folder.
			here := word{text: ".", literal: true, source: ".", expanded: ".", known: true}
			a.writeOwn(into(here, operands[0]), st, false)
			a.link(into(here, operands[0]), operands[0], st)
		}
		return
	}
	if !folder {
		a.writeOwn(destination, st, false)
		if len(sources) == 1 {
			a.link(destination, sources[0], st)
		}
	}
	if noTargetFolder(args) {
		return
	}
	for _, source := range sources {
		a.writeOwn(into(destination, source), st, false)
		a.link(into(destination, source), source, st)
	}
}

// link records a symbolic link the input makes, so a later write through it
// in the same call is resolved as the file system will.
func (a *analyzer) link(at, target word, st *state) {
	if !at.known || !target.known {
		return
	}
	where := at.expanded
	if !path.IsAbs(where) {
		if st.cwd == "" {
			return
		}
		where = path.Join(st.cwd, where)
	}
	a.out.links[path.Clean(where)] = target.expanded
}

// noTargetFolder is ln -T: the destination is the link, never a folder it goes in.
func noTargetFolder(args []word) bool {
	for _, arg := range args {
		if !arg.literal || arg.text == "--" {
			return false
		}
		if arg.text == "--no-target-directory" || (strings.HasPrefix(arg.text, "-") && !strings.HasPrefix(arg.text, "--") && strings.Contains(arg.text, "T")) {
			return true
		}
	}
	return false
}
