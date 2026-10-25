import { setTimeout as wait } from 'node:timers/promises';

/** How often the screen is read while it settles after the stop. */
const SETTLE_POLL_MS = 250;
/** The longest the screen may take to settle: a screen that keeps changing never holds the pass longer. */
const SETTLE_MOST_MS = 5000;

/**
 * Stops a busy turn in a terminal for a forced message (decision 0040), as a
 * person does with Escape, then waits for the screen to settle: once it holds
 * still between two reads, the harness takes a new prompt, so the line typed
 * next starts the forced turn instead of joining the stopped one.
 */
export async function stopTurn(session: { escape: () => Promise<void>; screen: () => Promise<string> }, at: { pollMs?: number; mostMs?: number } = {}): Promise<void> {
  const { pollMs = SETTLE_POLL_MS, mostMs = SETTLE_MOST_MS } = at;
  await session.escape();
  const until = Date.now() + mostMs;
  let shown = await session.screen();
  while (Date.now() < until) {
    await wait(pollMs);
    const now = await session.screen();
    if (now === shown) {
      return;
    }
    shown = now;
  }
}
