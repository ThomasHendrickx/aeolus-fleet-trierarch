import { NO_TERMINAL_QUESTIONS } from '@aeolus-fleet/common';

/** A wake command with the line as its argument: a typed wake is one line, as Enter sends it. */
export function wakePromptOf(command: string): string {
  return `${command} ${NO_TERMINAL_QUESTIONS}`;
}

/** A first prompt with the line last, on a line of its own. */
export function firstPromptOf(prompt: string): string {
  return `${prompt}\n\n${NO_TERMINAL_QUESTIONS}`;
}
