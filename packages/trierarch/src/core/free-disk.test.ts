import { describe, expect, it } from 'vitest';

import { CollectingLogger, TestClock } from '../../test/support/in-memory.js';
import { createFreeDisk } from './free-disk.js';

function disk(at: { hasBrokenTrash?: boolean; hasBrokenImages?: boolean; hasBrokenCache?: boolean } = {}) {
  const stored = { trash: ['old-worktree'], images: ['old-image'], cache: ['unused-package'] };
  const logger = new CollectingLogger();
  const free = createFreeDisk({
    trash: { empty: () => {
      if (at.hasBrokenTrash === true) return Promise.reject(new Error('trash unavailable'));
      stored.trash = [];
      return Promise.resolve([]);
    } },
    images: { removeUnused: () => {
      if (at.hasBrokenImages === true) return Promise.reject(new Error('images unavailable'));
      stored.images = [];
      return Promise.resolve();
    } },
    cache: { trim: (_now, request) => {
      if (at.hasBrokenCache === true) return Promise.reject(new Error('cache unavailable'));
      // Ordinary trimming is not due yet. Urgent trimming moves entries to trash.
      if (request.isUrgent) { stored.trash.push(...stored.cache); stored.cache = []; }
      return Promise.resolve();
    } },
    clock: new TestClock(), logger,
  });
  return { free, stored, logger };
}

describe('freeing disk before the alert', () => {
  it('reclaims managed trash, unused images and evicted cache entries', async () => {
    const machine = disk();
    await machine.free();
    expect(machine.stored).toEqual({ trash: [], images: [], cache: [] });
  });

  it('reclaims images and cache when trash cannot be emptied', async () => {
    const machine = disk({ hasBrokenTrash: true });
    await machine.free();
    expect(machine.stored).toEqual({ trash: ['old-worktree', 'unused-package'], images: [], cache: [] });
  });

  it('reclaims trash and cache when images cannot be removed', async () => {
    const machine = disk({ hasBrokenImages: true });
    await machine.free();
    expect(machine.stored).toEqual({ trash: [], images: ['old-image'], cache: [] });
  });

  it('reclaims trash and images when cache cannot be trimmed', async () => {
    const machine = disk({ hasBrokenCache: true });
    await machine.free();
    expect(machine.stored).toEqual({ trash: [], images: [], cache: ['unused-package'] });
  });

  it('logs why trash could not be reclaimed', async () => {
    const machine = disk({ hasBrokenTrash: true });
    await machine.free();
    expect(machine.logger.warnings).toContain('Could not free disk: trash unavailable');
  });
});
