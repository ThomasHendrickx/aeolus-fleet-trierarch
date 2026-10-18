/**
 * A session's command, held a moment after it ends (#888). A command that
 * prints and exits at once can close its terminal before tmux has read what it
 * printed, and tmux then marks the pane dead with that output lost: the last
 * screen comes back blank. Holding the terminal open a moment after the command
 * ends lets tmux read it first; the command's own exit status stays the pane's.
 */

/** How long the terminal stays open after the command ended. */
export const HOLD_AFTER_EXIT_MS = 1000;

/** The shell script that runs the command, holds, then exits with the command's status. */
export const HOLD_SCRIPT = `"$@"; status=$?; sleep ${String(HOLD_AFTER_EXIT_MS / 1000)}; exit "$status"`;

/** The command as a session runs it: through sh, held after it ends. */
export function heldCommand(command: readonly string[]): string[] {
  return ['sh', '-c', HOLD_SCRIPT, 'sh', ...command];
}
