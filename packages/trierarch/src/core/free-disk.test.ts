import { describe, expect, it } from 'vitest';

import { CollectingLogger, TestClock } from '../../test/support/in-memory.js';
import { createFreeDisk } from './free-disk.js';

function disk(at: { hasBrokenTrash?: boolean } = {}) {
  const remaining = ['trash', 'images', 'cache', 'cache-trash'];
  const logger = new CollectingLogger();
  const reclaim = (kind: string): Promise<void> => {
    if (remaining[0] !== kind) return Promise.reject(new Error(`Wrong order: ${kind}`));
    remaining.shift();
    return Promise.resolve();
  };
  const free = createFreeDisk({
    trash: { empty: () => at.hasBrokenTrash === true ? Promise.reject(new Error('trash unavailable')) : reclaim(remaining.includes('cache') ? 'trash' : 'cache-trash').then(() => []) },
    images: { removeUnused: () => at.hasBrokenTrash === true ? Promise.resolve(remaining.splice(0, 2)).then(() => undefined) : reclaim('images') },
    cache: { trim: (_now, request) => request.isUrgent ? reclaim('cache') : Promise.reject(new Error('must bypass hourly interval')) },
    clock: new TestClock(), logger,
  });
  return { free, remaining, logger };
}

describe('freeing disk before the alert', () => {
  it('empties trash, removes images, trims cache urgently, and reclaims the cache trash', async () => {
    const machine = disk();
    await machine.free();
    expect(machine.remaining).toEqual([]);
  });

  it('continues removing images and trimming cache when trash cannot be emptied', async () => {
    const machine = disk({ hasBrokenTrash: true });
    await machine.free();
    expect(machine.remaining).toEqual(['cache-trash']);
    expect(machine.logger.warnings).toContain('Could not free disk: trash unavailable');
  });
});
