import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { expect, it } from 'vitest';

import { aCrewingMachine } from '../../support/crewing.js';
import { aFleet } from '../../support/fleet.js';
import { aMachine } from '../../support/machine.js';

it('ends with the test resources still in use', async () => {
  const fleet = await aFleet();
  const machine = await aMachine();
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
  const recorded = [process.pid, service, proxy].map((pid) => {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return { pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
  });
  writeFileSync(process.env.PROCESS_CLEANUP_PIDS ?? '', JSON.stringify(recorded));
  if (process.env.PROCESS_CLEANUP_ENDING === 'timeout') {
    await wait(120_000);
  } else if (process.env.PROCESS_CLEANUP_ENDING === 'failure') {
    throw new Error('the fixture test failed');
  }
});
