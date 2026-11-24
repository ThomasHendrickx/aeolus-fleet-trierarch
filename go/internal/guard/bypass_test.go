package guard

import "testing"

// bypass is one known way around a check on the command text (the lessons
// table of the guard design, section 2), kept as a regression case.
type bypass struct {
	name, command, want string
}

func runBypasses(t *testing.T, rules string, bypasses []bypass) {
	t.Helper()
	for _, tt := range bypasses {
		t.Run(tt.name, func(t *testing.T) {
			checker, _ := aChecker(aSet("rules", "abcdef1", rules))
			refusedAs(t, checker, aShellCall(tt.command), tt.want)
		})
	}
}

const curlDenied = "Refused by the guard: commands.deny curl, in rules @ abcdef1."

func TestTheShellBypassesAreClosed(t *testing.T) {
	runBypasses(t, noCurl, []bypass{
		{"sh -c with a literal string", "sh -c 'curl x'", curlDenied},
		{"bash -c with options before it", `bash -e -o pipefail -c "curl x"`, curlDenied},
		{"bash -lc", "bash -lc 'curl x'", curlDenied},
		{"sh -c nested in sh -c", `sh -c "bash -c 'curl x'"`, curlDenied},
		{"zsh -c", "zsh -c 'curl x'", curlDenied},
		{"sh -c with a string built at run time", `sh -c "$X"`, `Refused by the guard: unresolvable: sh -c of "$X".`},
		{"sh -c with a substitution", `bash -c "$(cat cmd.txt)"`, `Refused by the guard: unresolvable: bash -c of "$(cat cmd.txt)".`},
		{"eval of literal words", "eval curl x", curlDenied},
		{"eval of a literal string", `eval 'curl x'`, curlDenied},
		{"eval of a variable", `eval "$X"`, `Refused by the guard: unresolvable: eval of "$X".`},
		{"eval of a substitution", "eval $(echo curl x)", `Refused by the guard: unresolvable: eval of $(echo curl x).`},
		{"a command name from a variable", "$CMD x", `Refused by the guard: unresolvable: command name $CMD.`},
		{"a command name from a variable set before", "C=curl; $C x", `Refused by the guard: unresolvable: command name $C.`},
		{"a command name in braces", "${CMD} x", `Refused by the guard: unresolvable: command name ${CMD}.`},
		{"a command name from a substitution", "$(echo curl) x", `Refused by the guard: unresolvable: command name $(echo curl).`},
		{"a command name joined from parts", `cu"$R"l x`, `Refused by the guard: unresolvable: command name cu"$R"l.`},
		{"a command name from ANSI-C quoting", `$'\x63url' x`, `Refused by the guard: unresolvable: command name $'\x63url'.`},
		{"a command name from brace expansion", "{curl,x}", `Refused by the guard: unresolvable: command name {curl,x}.`},
		{"a command name from a glob", "/usr/bin/cur? x", `Refused by the guard: unresolvable: command name /usr/bin/cur?.`},
		{"an alias", "alias c='curl x'; c", curlDenied},
		{"an alias defined at run time", `alias c="$X"`, `Refused by the guard: unresolvable: alias c="$X".`},
		{"a function", "c() { curl x; }; c", curlDenied},
		{"a trap", "trap 'curl x' EXIT", curlDenied},
		{"a trap built at run time", `trap "$X" EXIT`, `Refused by the guard: unresolvable: trap of "$X".`},
		{"python -c built at run time", `python3 -c "$CODE"`, `Refused by the guard: unresolvable: python3 -c of "$CODE".`},
		{"node -e built at run time", `node -e "$CODE"`, `Refused by the guard: unresolvable: node -e of "$CODE".`},
		{"perl -e built at run time", `perl -e "$CODE"`, `Refused by the guard: unresolvable: perl -e of "$CODE".`},
		{"ruby -e built at run time", `ruby -e "$CODE"`, `Refused by the guard: unresolvable: ruby -e of "$CODE".`},
		{"a script piped to a shell", "echo 'curl x' | sh", "Refused by the guard: unresolvable: sh script from stdin."},
		{"a script from a file piped to a shell", "cat x.sh | bash -s", "Refused by the guard: unresolvable: bash script from stdin."},
		{"a script in a heredoc", "sh <<'EOF'\ncurl x\nEOF", curlDenied},
		{"a script in a here string", "bash <<< 'curl x'", curlDenied},
		{"a script in a heredoc built at run time", "sh <<EOF\n$X\nEOF", "Refused by the guard: unresolvable: sh script from stdin."},
		{"source of a variable", `source "$F"`, `Refused by the guard: unresolvable: source of "$F".`},
		{"dot of a variable", `. $F`, `Refused by the guard: unresolvable: . of $F.`},
		{"xargs running a variable", `xargs "$CMD"`, `Refused by the guard: unresolvable: xargs running "$CMD".`},
		{"find -exec running a variable", `find . -exec "$CMD" {} \;`, `Refused by the guard: unresolvable: find -exec running "$CMD".`},
	})
}

func TestALiteralProgramOfAnInterpreterRuns(t *testing.T) {
	checker, _ := aChecker(aSet("no-curl", "abcdef1", noCurl))

	allowed(t, checker, aShellCall(`python3 -c 'print(1)'`))
	allowed(t, checker, aShellCall("sh ./build.sh"))
	allowed(t, checker, aShellCall("source ./env.sh"))
}
