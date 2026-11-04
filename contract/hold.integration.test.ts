import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aCrewingMachine, sessionOf, isRunning, listedEntryOf, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// The hold and the hand-over, as a session sees them: each session runs under a hold of its own that outlives the trierarch, takes its ship's messages through the aeolus-fleet plugin's hooks, and only its own ship's (docs/trierarch.md, "Waking a session").

const CREWED_WITHIN_MS = 30_000;
/** A pass hands an idle session one message every 5 seconds. */
const HANDED_WITHIN_MS = 30_000;
/** Long enough for two passes, in which a running trierarch would hand a message over. */
const PASSES_MS = 12_000;
/** How every crew token core issues starts. */
const CREW_TOKEN_PREFIX = 'aeolus_ct_v1_';
const MESSAGE = 'Review PR 12 and say what you found';

let fleet: Fleet;
let machine: Machine;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
  await aCrewingMachine({ fleet, machine });
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

/** Commissions the ship, crews it in a worktree and waits until the trierarch lists it running and its first turn ended. */
async function aRunningShip(name: string): Promise<ShipId> {
  const shipId = await fleet.commission(name);
  await fleet.crewInWorktree(shipId, { repository: REPOSITORY, harness: 'claude-code' });
  await expect.poll(async () => (await listedEntryOf(machine, shipId))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
  await expect.poll(() => sessionOf(machine, name).turns().length, { timeout: CREWED_WITHIN_MS }).toBeGreaterThan(0);
  return shipId;
}

/** What the plugin's hooks put into the ship's turns. */
function contextsOf(name: string): string {
  return sessionOf(machine, name)
    .turns()
    .map((turn) => turn.context)
    .join('\n');
}

describe('the hold', () => {
  it("keeps the session's hold in its own folder, the session its child", async () => {
    const shipId = await aRunningShip('scout');

    const holdPid = Number(readFileSync(join(machine.trierarchHome, 'sessions', shipId, 'hold.pid'), 'utf8').trim());

    expect(isRunning(holdPid)).toBe(true);
    const sessionPid = sessionOf(machine, 'scout').starts()[0]?.pid ?? 0;
    expect(readFileSync(`/proc/${String(sessionPid)}/stat`, 'utf8').split(' ')[3]).toBe(String(holdPid));
  });

  it("starts the session in an environment holding no crew token and none of the trierarch's own variables", async () => {
    await aRunningShip('scout');

    const env = sessionOf(machine, 'scout').starts()[0]?.env ?? {};

    expect(Object.values(env).filter((value) => value.includes(CREW_TOKEN_PREFIX))).toEqual([]);
    expect(Object.keys(env).filter((name) => name.startsWith('AEOLUS_') && name !== 'AEOLUS_LAUNCH')).toEqual([]);
    expect(env).toHaveProperty('AEOLUS_LAUNCH');
  });
});

describe('the hand-over', () => {
  it("hands a message to its ship's idle session: its turn holds it, and the delivery ends handled", async () => {
    await aRunningShip('scout');

    const messageId = await fleet.send('scout', MESSAGE);

    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: HANDED_WITHIN_MS }).toBe('handled');
    expect(contextsOf('scout')).toContain(MESSAGE);
  });

  it('hands a message sent while the trierarch was stopped once it runs again, to the session that kept running', async () => {
    await aRunningShip('scout');
    const session = sessionOf(machine, 'scout');
    const stop = await machine.trierarch(['stop']);
    expect(stop.status, stop.stdout + stop.stderr).toBe(0);

    const messageId = await fleet.send('scout', MESSAGE);
    await wait(PASSES_MS);
    expect(contextsOf('scout')).not.toContain(MESSAGE);
    const start = await machine.trierarch(['start']);

    expect(start.status, start.stdout + start.stderr).toBe(0);
    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: HANDED_WITHIN_MS }).toBe('handled');
    expect(contextsOf('scout')).toContain(MESSAGE);
    expect(session.starts()).toHaveLength(1);
  });

  it("hands each of two sessions only its own ship's message, sent at once", async () => {
    await aRunningShip('scout');
    await aRunningShip('lookout');

    const messageIds = await Promise.all([fleet.send('scout', 'Only for scout'), fleet.send('lookout', 'Only for lookout')]);

    await expect.poll(() => Promise.all(messageIds.map((messageId) => fleet.deliveryStateOf(messageId))), { timeout: HANDED_WITHIN_MS }).toEqual(['handled', 'handled']);
    expect(contextsOf('scout')).toContain('Only for scout');
    expect(contextsOf('scout')).not.toContain('Only for lookout');
    expect(contextsOf('lookout')).toContain('Only for lookout');
    expect(contextsOf('lookout')).not.toContain('Only for scout');
  });
});
