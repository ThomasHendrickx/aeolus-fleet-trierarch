import { beforeEach, describe, expect, it } from 'vitest';

import type { RunningFile } from '../adapters/files.js';
import type { ServiceStatus } from '../adapters/service.js';
import { runServiceCommand, type ServiceCommand } from './service-command.js';

const FILE = '/systemd/user/aeolus-trierarch.service';
const LOGS = '/home/.aeolus/trierarch/logs';

let steps: string[];
/** What running.json says on each read after the command, the last one from then on. */
let saying: (RunningFile | undefined)[];
let reads: number;
let waits: number[];

beforeEach(() => {
  steps = [];
  saying = [{ pid: 2, version: '0.21.0' }];
  reads = 0;
  waits = [];
});

const step = (name: string) => () => {
  steps.push(name);
  return Promise.resolve();
};

const service = {
  start: step('start'),
  restart: step('restart'),
  install: step('install'),
  status: (): Promise<ServiceStatus> => Promise.resolve({ file: FILE, isInstalled: true, isRunning: true, pid: 2 }),
};

function run(command: ServiceCommand) {
  return runServiceCommand({
    command,
    service,
    logs: LOGS,
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

describe('a command that starts or restarts the service (#466)', () => {
  it.each(['start', 'restart', 'install'] as const)('%s waits until the new process says its version in running.json, its pid the one the service runs', async (command) => {
    saying = [{ pid: 1, version: '0.21.0' }, undefined, { pid: 2, version: '0.21.0' }];

    const answer = await run(command);

    expect(steps).toEqual([command]);
    expect(waits).toEqual([1000, 1000]);
    expect(answer.status).toEqual({ file: FILE, isInstalled: true, isRunning: true, pid: 2 });
  });

  it.each([
    ['start', 'The trierarch started: it runs as pid 2.'],
    ['restart', 'The trierarch restarted: it runs as pid 2.'],
    ['install', `Installed ${FILE}. Logs: ${LOGS}`],
  ] as const)('%s says what it did once the new process has said its version', async (command, text) => {
    const answer = await run(command);

    expect(answer.text).toBe(text);
  });

  it.each(['start', 'restart', 'install'] as const)('%s stops waiting after 30 seconds when the new process has not said its version, and says so', async (command) => {
    saying = [{ pid: 1, version: '0.21.0' }];

    const answer = await run(command);

    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(30_000);
    expect(answer.text).toContain('The new process has not said its version after 30 seconds: aeolus-trierarch status shows the version it runs once it does.');
  });
});
