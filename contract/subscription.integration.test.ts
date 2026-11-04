import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, sessionOf, listedEntryOf, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// A session on its subscription never starts with a key in reach (docs/trierarch.md, "API keys", K6 and K2): what Claude Code reads itself would give it a key, so the request is given back while its crew is not final, and the ship waits once it is.

const CREWED_WITHIN_MS = 30_000;
/** Long enough for a pass or two after the session ended, and its wait before it would start again. */
const PASSES_MS = 15_000;
/** The helper's command, which no cause may name. */
const HELPER = 'contract-key-helper-not-real';

let fleet: Fleet;
let machine: Machine;
let scout: ShipId;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
  await aCrewingMachine({ fleet, machine });
  scout = await fleet.commission('scout');
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

/** Claude Code's user settings, as it reads them. */
function userSettings(): string {
  return join(machine.home, '.claude', 'settings.json');
}

/** Gives Claude Code's user settings an `apiKeyHelper`, keeping what init wrote there. */
function aKeyHelperInUserSettings(): void {
  const file = userSettings();
  const settings = existsSync(file) ? z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, 'utf8'))) : {};
  mkdirSync(join(machine.home, '.claude'), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...settings, apiKeyHelper: HELPER }));
}

describe('a session on its subscription', () => {
  it("is never started while Claude Code's settings hold an apiKeyHelper: the request is given back, naming it and where, never its value", async () => {
    aKeyHelperInUserSettings();

    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: CREWED_WITHIN_MS }).toBe(`mac-mini: claude-code would reach an API key on its subscription (apiKeyHelper in ${userSettings()}): remove it, or run the ship on its API key`);
    expect(sessionOf(machine, 'scout').starts()).toEqual([]);
    await expect(fleet.leasesOf(scout)).resolves.toBe(0);
  });

  it('of a final crew waits, restarting with no restart counted, once an apiKeyHelper is in reach', async () => {
    const session = sessionOf(machine, 'scout');
    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
    aKeyHelperInUserSettings();

    // The session the trierarch started for this test ends, by its own pid, as a crash ends it: that end is the one restart counted.
    process.kill(session.starts()[0]?.pid ?? 0, 'SIGKILL');
    await expect.poll(() => listedEntryOf(machine, scout), { timeout: CREWED_WITHIN_MS }).toMatchObject({ state: 'restarting', restarts: 1 });
    await wait(PASSES_MS);

    expect(session.starts()).toHaveLength(1);
    await expect(listedEntryOf(machine, scout)).resolves.toMatchObject({ state: 'restarting', restarts: 1 });
  });
});
