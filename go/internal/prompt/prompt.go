// Package prompt is what every prompt a harness is given carries: the line
// that no human reads the session's terminal (#585), so the session asks its
// questions over the fleet and no question waits in a pane nobody watches.
package prompt

// NoTerminalQuestions is common's NO_TERMINAL_QUESTIONS.
const NoTerminalQuestions = "No human reads this terminal. Never ask here; ask over the fleet. A question only a human can answer goes to your ship's owner (argo when argo owns your ship)."

// Wake is a wake with the line that no human reads as its argument: a typed wake is one line, as Enter sends it.
func Wake(command string) string {
	return command + " " + NoTerminalQuestions
}

// First is a crew request's first prompt with the line that no human reads last, on a line of its own.
func First(prompt string) string {
	return prompt + "\n\n" + NoTerminalQuestions
}
