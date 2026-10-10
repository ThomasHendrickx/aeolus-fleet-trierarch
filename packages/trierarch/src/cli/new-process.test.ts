import { beforeEach, describe, expect, it } from 'vitest';

import type { RunningFile } from '../adapters/files.js';
import type { ServiceStatus } from '../adapters/service.js';
import { startNewProcess } from './new-process.js';

let starts: number;
/** What running.json says on each read after the start, the last one from then on. */
let saying: (RunningFile | undefined)[];
let reads: number;
let waits: number[];

beforeEach(() => {
  starts = 0;
  saying = [{ pid: 2, version: '0.21.0' }];
  reads = 0;
  waits = [];
});

const service = {
  status: (): Promise<ServiceStatus> => Promise.resolve({ file: '/systemd/user/aeolus-trierarch.service', isInstalled: true, isRunning: true, pid: 2 }),
};

function start() {
  return startNewProcess({
    start: () => {
      starts += 1;
      return Promise.resolve();
    },
    service,
    running: () => {
      reads += 1;
      return Promise.resolve(saying[Math.min(reads, saying.length) - 1]);
    },
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
}

describe('starting a new trierarch process (#402)', () => {
  it('waits until the new process says its version in running.json, its pid the one the service runs, so the status that follows shows it', async () => {
    saying = [{ pid: 1, version: '0.21.0' }, undefined, { pid: 2, version: '0.21.0' }];

    const started = await start();

    expect(starts).toBe(1);
    expect(waits).toEqual([1000, 1000]);
    expect(started).toEqual({ status: { file: '/systemd/user/aeolus-trierarch.service', isInstalled: true, isRunning: true, pid: 2 }, hasSaidVersion: true });
  });

  it('stops waiting after 30 seconds when the new process has not said its version', async () => {
    saying = [{ pid: 1, version: '0.21.0' }];

    const started = await start();

    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(30_000);
    expect(started.hasSaidVersion).toBe(false);
  });
});
