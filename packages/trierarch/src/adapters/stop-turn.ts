import { setTimeout as wait } from 'node:timers/promises';

import type { ShipId } from '@aeolus-fleet/common';

import type { SessionRuntime } from '../core/ports.js';

/** How often the screen is read while it settles after the stop. */
const SETTLE_POLL_MS = 250;
/** The longest the screen may take to settle: a screen that keeps changing never holds the pass longer. */
const SETTLE_MOST_MS = 5000;

/**
 * Stops a session's busy turn for a forced message (decision 0040), as a
 * person does with Escape, then waits for the screen to settle: once it holds
 * still between two reads, the harness takes a new prompt, so the line typed
 * next starts the forced turn instead of joining the stopped one.
 */
export async function stopTurn(
  sessions: Pick<SessionRuntime, 'interrupt' | 'screen'>,
  at: { shipId: ShipId; pollMs?: number; mostMs?: number },
): Promise<void> {
  const { shipId, pollMs = SETTLE_POLL_MS, mostMs = SETTLE_MOST_MS } = at;
  await sessions.interrupt(shipId);
  const until = Date.now() + mostMs;
  let shown = await sessions.screen(shipId);
  while (Date.now() < until) {
    await wait(pollMs);
    const now = await sessions.screen(shipId);
    if (now === shown) {
      return;
    }
    shown = now;
  }
}
