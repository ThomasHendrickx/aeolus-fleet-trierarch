/**
 * The line every session the trierarch crews is told on its first and every
 * wake prompt (#585): nobody watches its pane, so a question asked there waits
 * for ever. The aeolus plugin's crew skills say the same to every ship.
 */
export const NO_TERMINAL_QUESTIONS = 'No human reads this terminal. Never ask here; ask over the fleet. A question only the operator can answer goes to argo.';

/** A wake command with the line as its argument: a typed wake is one line, as Enter sends it. */
export function wakePromptOf(command: string): string {
  return `${command} ${NO_TERMINAL_QUESTIONS}`;
}

/** A first prompt with the line last, on a line of its own. */
export function firstPromptOf(prompt: string): string {
  return `${prompt}\n\n${NO_TERMINAL_QUESTIONS}`;
}
