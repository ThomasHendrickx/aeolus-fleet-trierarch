import { describe, expect, it } from 'vitest';

import { loadStepsOf, lowResourcesOf, type MachineLoad } from './machine-load.js';

const GIB = 1024 ** 3;

/** A machine of 64 GiB memory, 8 cores and a 1000 GB disk, with what is free given. */
function aLoad(free: { availableMemory?: number; freeDisk?: number; loadAverage?: number; usedSwap?: number }): MachineLoad {
  return {
    memory: { totalBytes: 64 * GIB, availableBytes: free.availableMemory ?? 32 * GIB },
    swap: { totalBytes: 8 * GIB, usedBytes: free.usedSwap ?? 0 },
    cpu: { cores: 8, loadAverage: free.loadAverage ?? 1 },
    disk: { totalBytes: 1_000_000_000_000, freeBytes: free.freeDisk ?? 500_000_000_000 },
  };
}

describe('the machine load a trierarch reports (#400)', () => {
  it('is low on memory below 10 % available, and not at exactly 10 %', () => {
    expect([lowResourcesOf(aLoad({ availableMemory: 6.4 * GIB })), lowResourcesOf(aLoad({ availableMemory: 6.4 * GIB - 1 }))]).toEqual([[], ['memory']]);
  });

  it('is low on disk below 5 % free, and not at exactly 5 %', () => {
    expect([lowResourcesOf(aLoad({ freeDisk: 50_000_000_000 })), lowResourcesOf(aLoad({ freeDisk: 49_999_999_999 }))]).toEqual([[], ['disk']]);
  });

  it('is low on both at once', () => {
    expect(lowResourcesOf(aLoad({ availableMemory: GIB, freeDisk: 1_000_000_000 }))).toEqual(['memory', 'disk']);
  });

  it('is low on nothing a machine says it has none of', () => {
    const load = { ...aLoad({}), memory: { totalBytes: 0, availableBytes: 0 }, disk: { totalBytes: 0, freeBytes: 0 } };

    expect(lowResourcesOf(load)).toEqual([]);
  });

  it('keeps its steps while memory and disk move within 5 points of use, and CPU within half a load per core', () => {
    const before = aLoad({ availableMemory: 32 * GIB, freeDisk: 500_000_000_000, loadAverage: 1 });
    const after = aLoad({ availableMemory: 30 * GIB, freeDisk: 480_000_000_000, loadAverage: 3.9 });

    expect(loadStepsOf(after)).toEqual(loadStepsOf(before));
  });

  it.each([
    ['memory crosses 5 points of use', aLoad({ availableMemory: 28.8 * GIB })],
    ['disk crosses 5 points of use', aLoad({ freeDisk: 450_000_000_000 })],
    ['CPU crosses half a load per core', aLoad({ loadAverage: 4 })],
    ['swap crosses 5 points of use', aLoad({ usedSwap: 0.5 * GIB })],
  ])('takes another step when %s', (_label, after) => {
    expect(loadStepsOf(after)).not.toEqual(loadStepsOf(aLoad({})));
  });
});
