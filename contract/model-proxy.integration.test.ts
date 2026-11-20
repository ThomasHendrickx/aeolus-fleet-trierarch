import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aCrewingMachine, sessionOf, listedEntryOf, isRunning, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// The model proxy (docs/trierarch.md, "API keys"): while a harness holds an API key the proxy runs on loopback, and a session on the key reaches its vendor only through it, with a token of its own, never the key.

const CREWED_WITHIN_MS = 30_000;
const KEY = 'sk-ant-api03-contract-key-not-real';
const HTTP_UNAUTHORIZED = 401;

let fleet: Fleet;
let machine: Machine;
let scout: ShipId;
let isMachineRemoved: boolean;

beforeEach(async () => {
  isMachineRemoved = false;
  fleet = await aFleet();
  machine = await aMachine();
  await aCrewingMachine({ fleet, machine });
  // The key as `login claude-code --api-key` keeps it once the vendor took it: login itself asks Anthropic, which a test does not reach.
  const keys = join(machine.trierarchHome, 'keys');
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  writeFileSync(join(keys, 'claude-code'), KEY, { mode: 0o600 });
  scout = await fleet.commission('scout');
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail' && !isMachineRemoved) {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  if (!isMachineRemoved) await machine.remove();
  await fleet.close();
});

/** The proxy's address on loopback, from its port file; none while it has none. */
function proxyUrl(): string | undefined {
  const port = join(machine.trierarchHome, 'proxy', 'port');
  return existsSync(port) ? `http://127.0.0.1:${readFileSync(port, 'utf8').trim()}` : undefined;
}

async function aRunningScout(): Promise<void> {
  await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
  await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
}

describe('the model proxy', () => {
  it('records the proxy pid when it starts', async () => {
    const pidFile = join(machine.trierarchHome, 'proxy', 'proxy.pid');
    const recorded = join(machine.machine, 'proxy-started-pids');
    await expect.poll(() => existsSync(pidFile), { timeout: CREWED_WITHIN_MS }).toBe(true);
    const pid = readFileSync(pidFile, 'utf8').trim();
    await expect.poll(() => existsSync(recorded) ? readFileSync(recorded, 'utf8').split('\n').some((line) => line.startsWith(`${pid} `)) : false).toBe(true);
  });

  it('leaves none of its model proxy processes running when the machine is removed', async () => {
    const pidFile = join(machine.trierarchHome, 'proxy', 'proxy.pid');
    await expect.poll(() => existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0, { timeout: CREWED_WITHIN_MS }).toBeGreaterThan(1);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(1);
    expect(isRunning(pid)).toBe(true);
    try {
      isMachineRemoved = true;
      await machine.remove();
      expect(Number(isRunning(pid))).toBe(0);
    } finally {
      if (isRunning(pid)) process.kill(pid, 'SIGTERM');
    }
  });

  it('runs on loopback once a harness holds an API key, started by the next pass', async () => {
    await expect.poll(proxyUrl, { timeout: CREWED_WITHIN_MS }).toBeDefined();
    await expect.poll(async () => (await fetch(`${proxyUrl() ?? ''}/aeolus/state`).catch(() => undefined))?.status, { timeout: CREWED_WITHIN_MS }).toBe(200);
  });

  it('stops the model proxy on uninstall', async () => {
    await expect.poll(proxyUrl, { timeout: CREWED_WITHIN_MS }).toBeDefined();
    const address = proxyUrl() ?? '';
    await expect.poll(async () => (await fetch(`${address}/aeolus/state`).catch(() => undefined))?.status, { timeout: CREWED_WITHIN_MS }).toBe(200);
    const pid = Number(readFileSync(join(machine.trierarchHome, 'proxy', 'proxy.pid'), 'utf8'));
    try {
      const result = await machine.trierarch(['uninstall']);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(await fetch(`${address}/aeolus/state`).catch(() => undefined)).toBeUndefined();
    } finally {
      // This test started the proxy; clean it up even when uninstall fails.
      if ((await fetch(`${address}/aeolus/state`).catch(() => undefined))?.ok === true) {
        process.kill(pid, 'SIGTERM');
      }
    }
  });

  it('starts a session of a harness whose default login is its key with the proxy as its base URL and a token of its own, never the key', async () => {
    const login = await machine.trierarch(['login', 'claude-code', '--default', 'api-key']);
    expect(login.status, login.stdout + login.stderr).toBe(0);
    await aRunningScout();

    const env = sessionOf(machine, 'scout').starts()[0]?.env ?? {};

    expect(env.ANTHROPIC_BASE_URL).toBe(`${proxyUrl() ?? ''}/anthropic`);
    expect(env.ANTHROPIC_AUTH_TOKEN).toEqual(expect.any(String));
    expect(Object.values(env).filter((value) => value.includes(KEY))).toEqual([]);
  });

  it("refuses a call that carries no running session's token, naming no key", async () => {
    await aRunningScout();
    await expect.poll(proxyUrl, { timeout: CREWED_WITHIN_MS }).toBeDefined();

    const answer = await fetch(`${proxyUrl() ?? ''}/anthropic/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer not-a-session-token', 'content-type': 'application/json' }, body: '{}' });

    expect(answer.status).toBe(HTTP_UNAUTHORIZED);
    expect(await answer.text()).not.toContain(KEY);
  });
});
