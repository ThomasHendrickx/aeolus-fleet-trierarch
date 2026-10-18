import { describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { stopTurn } from './stop-turn.js';

const shipId = newId('ship');
const QUICK = { pollMs: 5, mostMs: 200 };

/** A session whose screen shows each of `screens` in turn, the last one from then on, and that writes down each step. */
function aSession(screens: readonly string[]) {
  const steps: string[] = [];
  let reads = 0;
  return {
    steps,
    sessions: {
      interrupt: (stopped: typeof shipId) => {
        steps.push(`interrupt ${stopped}`);
        return Promise.resolve();
      },
      screen: () => {
        reads += 1;
        steps.push('screen');
        return Promise.resolve(screens[Math.min(reads, screens.length) - 1] ?? '');
      },
    },
  };
}

describe("stopping a session's busy turn for a forced message (decision 0040)", () => {
  it('stops the turn first, then reads the screen until it holds still', async () => {
    const session = aSession(['Working', 'Interrupted', '> ', '> ']);

    await stopTurn(session.sessions, { shipId, ...QUICK });

    expect(session.steps).toEqual([`interrupt ${shipId}`, 'screen', 'screen', 'screen', 'screen']);
  });

  it('waits at most its longest for a screen that keeps changing, so the pass goes on', async () => {
    let count = 0;
    const steps: string[] = [];
    const sessions = {
      interrupt: () => Promise.resolve(),
      screen: () => {
        count += 1;
        steps.push('screen');
        return Promise.resolve(`frame ${String(count)}`);
      },
    };
    const startedAt = Date.now();

    await stopTurn(sessions, { shipId, pollMs: 5, mostMs: 50 });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(steps.length).toBeGreaterThan(1);
  });
});
