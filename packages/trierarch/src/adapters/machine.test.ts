import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMachine, linuxSwapOf, macosMemoryOf, macosSwapOf } from './machine.js';

const KIB = 1024;
const MIB = 1024 ** 2;

/** As a Linux machine of 64 GB says it in /proc/meminfo. */
const MEMINFO = ['MemTotal:       65712172 kB', 'MemFree:         2577464 kB', 'MemAvailable:   55071600 kB', 'Cached:         42111080 kB', 'SwapTotal:       8388604 kB', 'SwapFree:        4189960 kB', ''].join('\n');

/** As a Mac says it with vm_stat. */
const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                3000.',
  'Pages active:                            400000.',
  'Pages inactive:                          380000.',
  'Pages speculative:                        20000.',
  'Pages throttled:                              0.',
  'Pages wired down:                        150000.',
  'Pages purgeable:                          10000.',
  '"Translation faults":                 123456789.',
  'Pages stored in compressor:              90000.',
  '',
].join('\n');

describe("the machine's load, as the operating system says it (#400)", () => {
  it('reads the swap a Linux machine has and uses', () => {
    expect(linuxSwapOf(MEMINFO)).toEqual({ totalBytes: 8_388_604 * KIB, usedBytes: (8_388_604 - 4_189_960) * KIB });
  });

  it('reads the memory a Mac has, and as available its free, inactive, speculative and purgeable pages, as Activity Monitor counts what is not used', () => {
    expect(macosMemoryOf({ memsize: '68719476736\n', vmStat: VM_STAT })).toEqual({ totalBytes: 68_719_476_736, availableBytes: (3000 + 380_000 + 20_000 + 10_000) * 16_384 });
  });

  it('reads the swap a Mac has and uses', () => {
    expect(macosSwapOf('total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)\n')).toEqual({ totalBytes: 2048 * MIB, usedBytes: 1024.5 * MIB });
  });

  it('says no swap from text it does not know', () => {
    expect([linuxSwapOf('MemTotal: 1 kB\n'), macosSwapOf('')]).toEqual([undefined, undefined]);
  });

  it('reads the load of the machine the tests run on, and the disk of a worktree root not made yet by the folder it will be in', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'aeolus-machine-'));
    try {
      const load = await createMachine({ worktreeRoot: join(folder, 'worktrees', 'not-yet') }).load();

      expect(load.memory.availableBytes).toBeLessThanOrEqual(load.memory.totalBytes);
      expect(load.memory.totalBytes).toBeGreaterThan(0);
      expect(load.disk.freeBytes).toBeLessThanOrEqual(load.disk.totalBytes);
      expect(load.disk.totalBytes).toBeGreaterThan(0);
      expect(load.cpu.cores).toBeGreaterThan(0);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
