import { describe, expect, it } from 'vitest';

import { decideRestart, RESTART_BUDGET } from './restart-policy.js';

const NOW = new Date('2026-10-06T08:00:00.000Z');
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/** Exits a minute apart, the last one now. */
function exits(count: number): string[] {
  return Array.from({ length: count }, (_, index) => new Date(NOW.getTime() - (count - 1 - index) * MINUTE_MS).toISOString());
}

describe('the restart policy', () => {
  it.each([
    [1, 5 * SECOND_MS],
    [2, 30 * SECOND_MS],
    [3, 2 * MINUTE_MS],
    [4, 10 * MINUTE_MS],
    [5, 10 * MINUTE_MS],
  ])('restarts after exit %i in the hour with its wait', (count, waitMs) => {
    expect(decideRestart(exits(count), NOW)).toEqual({ kind: 'restart', at: new Date(NOW.getTime() + waitMs) });
  });

  it('spends the budget of 5 restarts an hour: the next exit crashes the entry', () => {
    expect(decideRestart(exits(RESTART_BUDGET + 1), NOW)).toEqual({ kind: 'crashed' });
  });

  it('counts no exit older than an hour', () => {
    const anHourAgo = new Date(NOW.getTime() - 60 * MINUTE_MS).toISOString();

    expect(decideRestart([anHourAgo, ...exits(RESTART_BUDGET)], NOW)).toMatchObject({ kind: 'restart' });
  });
});
