/**
 * The restart policy (docs/architecture.md, "The trierarch"): a session that
 * dies starts again after 5 s, 30 s, 2 min, then 10 min each time, with a
 * budget of 5 restarts an hour, after which the entry is crashed.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/** The wait before each restart in the window, then the last one for every later restart. */
export const RESTART_DELAYS_MS = [5 * SECOND_MS, 30 * SECOND_MS, 2 * MINUTE_MS, 10 * MINUTE_MS] as const;
export const RESTART_BUDGET = 5;
export const RESTART_WINDOW_MS = 60 * MINUTE_MS;

export type RestartDecision = { readonly kind: 'restart'; readonly at: Date } | { readonly kind: 'crashed' };

/** The exits still inside the window at now. */
export function exitsInWindow(exits: readonly string[], now: Date): string[] {
  return exits.filter((exit) => now.getTime() - new Date(exit).getTime() < RESTART_WINDOW_MS);
}

/** What to do after an exit, given every exit inside the window, this one included. */
export function decideRestart(exits: readonly string[], now: Date): RestartDecision {
  const count = exitsInWindow(exits, now).length;
  if (count > RESTART_BUDGET) {
    return { kind: 'crashed' };
  }
  const delay = RESTART_DELAYS_MS[Math.min(count, RESTART_DELAYS_MS.length) - 1] ?? RESTART_DELAYS_MS[0];
  return { kind: 'restart', at: new Date(now.getTime() + delay) };
}
