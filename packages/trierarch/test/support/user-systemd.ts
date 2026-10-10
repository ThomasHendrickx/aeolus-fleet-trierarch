import type { CommandResult } from '../../src/adapters/run-command.js';

/**
 * Whether the tests that run units under the real systemd user manager can run
 * on this machine, and why not where they cannot, so a skip says why (#552).
 */
export type UserSystemd = { readonly isUsable: true } | { readonly isUsable: false; readonly reason: string };

/**
 * The states in which the user manager starts and stops units. Degraded only
 * says some unit failed, one of the machine's own, not one the tests start.
 */
const USABLE_STATES: readonly string[] = ['running', 'degraded'];

/** Asks `systemctl --user is-system-running`, which answers its state and exits non-zero for every state but running. */
export async function userSystemd(machine: { platform: NodeJS.Platform; isSystemRunning: () => Promise<CommandResult> }): Promise<UserSystemd> {
  if (machine.platform !== 'linux') {
    return { isUsable: false, reason: `systemd runs on Linux only, not on ${machine.platform}` };
  }
  let answer: CommandResult;
  try {
    answer = await machine.isSystemRunning();
  } catch (error) {
    return { isUsable: false, reason: `systemctl --user does not run here: ${error instanceof Error ? error.message : String(error)}` };
  }
  const state = answer.stdout.trim();
  if (state === '') {
    return { isUsable: false, reason: `systemctl --user reaches no user manager: ${answer.stderr.trim()}` };
  }
  return USABLE_STATES.includes(state) ? { isUsable: true } : { isUsable: false, reason: `the systemd user manager is ${state}` };
}
