import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { expect, it, onTestFinished } from 'vitest';

import { aCrewingMachine } from '../../support/crewing.js';
import { aFleet } from '../../support/fleet.js';
import { aMachine } from '../../support/machine.js';

it('ends with the test resources still in use', async () => {
  const fleet = await aFleet();
  const machine = await aMachine();
  onTestFinished(() => {
    const stat = readFileSync(`/proc/${String(process.pid)}/stat`, 'utf8');
    const worker = { pid: process.pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
    const files = [join(machine.machine, 'systemd', 'started'), join(machine.machine, 'proxy-started-pids')];
    const started = files.flatMap((file) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [pid = '', start = ''] = line.split(' ');
      return { pid: Number(pid), start };
    }) : []);
    writeFileSync(process.env.PROCESS_CLEANUP_PIDS ?? '', JSON.stringify([worker, ...started]));
  });
  const keys = join(machine.trierarchHome, 'keys');
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  writeFileSync(join(keys, 'claude-code'), 'sk-ant-api03-contract-key-not-real', { mode: 0o600 });
  await aCrewingMachine({ fleet, machine });
  const proxyFile = join(machine.trierarchHome, 'proxy', 'proxy.pid');
  await expect.poll(() => existsSync(proxyFile), { timeout: 30_000 }).toBe(true);
  const service = machine.servicePid();
  const proxy = Number(readFileSync(proxyFile, 'utf8'));
  expect(service).toBeGreaterThan(1);
  expect(proxy).toBeGreaterThan(1);
  const serviceRecords = readFileSync(join(machine.machine, 'systemd', 'started'), 'utf8').split('\n');
  const proxyRecords = readFileSync(join(machine.machine, 'proxy-started-pids'), 'utf8').split('\n');
  expect(serviceRecords.some((line) => line.startsWith(`${String(service)} `))).toBe(true);
  expect(proxyRecords.some((line) => line.startsWith(`${String(proxy)} `))).toBe(true);
  if (process.env.PROCESS_CLEANUP_ENDING === 'timeout') {
    await wait(120_000);
  } else if (process.env.PROCESS_CLEANUP_ENDING === 'failure') {
    throw new Error('the fixture test failed');
  }
});
