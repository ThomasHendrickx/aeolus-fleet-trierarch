import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, listedEntryOf, REPOSITORY, sessionOf, setupLineOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';
import { isTodaysTrierarch, TODAYS_TRIERARCH, TRIERARCH_UNDER_TEST } from './support/trierarch-under-test.js';

// A machine moves from one trierarch to another by the other's setup line and a restart, as by an upgrade: each session runs on under its hold, and a hold another version started is taken over once its session's turn is idle (docs/trierarch.md, "Crewing a ship"; headless H19). Today's trierarch and the one under test take over each other's holds; the suite drives two trierarchs only when one other than today's is under test.

const CREWED_WITHIN_MS = 30_000;
/** A pass every 5 seconds: the session's turn is idle after its first, and the next pass takes its hold over. */
const TAKEN_OVER_WITHIN_MS = 45_000;
const HANDED_WITHIN_MS = 30_000;

let fleet: Fleet;
let machine: Machine;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

const versionSchema = z.object({ version: z.string() });
const stateSchema = z.object({ isOk: z.literal(true), state: z.object({ status: z.literal('running'), version: z.string() }) });

/** The version the trierarch of the command says it is. */
async function versionOf(command: readonly string[]): Promise<string> {
  return versionSchema.parse(JSON.parse((await machine.trierarch(['--version', '--json'], { as: command })).stdout)).version;
}

/** What the ship's hold says it is on its socket, as the trierarch asks it: its version; none while no hold answers. */
function holdVersionOf(shipId: ShipId): Promise<string | undefined> {
  return new Promise((resolve) => {
    const connection = connect(join(machine.trierarchHome, 'sessions', shipId, 'hold.sock'));
    let received = '';
    connection.setTimeout(2_000, () => {
      connection.destroy();
    });
    connection.on('connect', () => connection.write(`${JSON.stringify({ call: 'state' })}\n`));
    connection.on('data', (chunk: Buffer) => (received += chunk.toString('utf8')));
    connection.on('error', () => {
      resolve(undefined);
    });
    connection.on('close', () => {
      try {
        resolve(stateSchema.parse(JSON.parse(received.split('\n')[0] ?? '')).state.version);
      } catch {
        resolve(undefined);
      }
    });
  });
}

function holdPidOf(shipId: ShipId): string {
  return readFileSync(join(machine.trierarchHome, 'sessions', shipId, 'hold.pid'), 'utf8').trim();
}

/** Crews the ship with the first trierarch, moves the machine to the second by its setup line and a restart, and waits until the second's hold holds the session. */
async function takenOver(from: readonly string[], to: readonly string[]): Promise<ShipId> {
  const [fromVersion, toVersion] = [await versionOf(from), await versionOf(to)];
  expect(toVersion, 'the two trierarchs must say different versions, as two releases do, for one to take over the other').not.toBe(fromVersion);
  await aCrewingMachine({ fleet, machine, as: from });
  const shipId = await fleet.commission('scout');
  await fleet.crewInWorktree(shipId, { repository: REPOSITORY, harness: 'claude-code' });
  await expect.poll(async () => (await listedEntryOf(machine, shipId))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
  await expect.poll(() => holdVersionOf(shipId), { timeout: CREWED_WITHIN_MS }).toBe(fromVersion);
  await expect.poll(() => sessionOf(machine, 'scout').turns().length, { timeout: CREWED_WITHIN_MS }).toBeGreaterThan(0);
  const before = holdPidOf(shipId);

  const moved = await machine.trierarch(setupLineOf(fleet), { as: to });
  const restarted = await machine.trierarch(['restart'], { as: to });

  expect(moved.status, moved.stdout + moved.stderr).toBe(0);
  expect(restarted.status, restarted.stdout + restarted.stderr).toBe(0);
  await expect.poll(() => holdVersionOf(shipId), { timeout: TAKEN_OVER_WITHIN_MS }).toBe(toVersion);
  expect(holdPidOf(shipId)).not.toBe(before);
  return shipId;
}

describe.skipIf(isTodaysTrierarch)('a hold of another trierarch', () => {
  it("is taken over from today's trierarch once its session is idle, and the session goes on with its messages", async () => {
    const shipId = await takenOver(TODAYS_TRIERARCH, TRIERARCH_UNDER_TEST);

    const messageId = await fleet.send('scout', 'Review PR 12 and say what you found');

    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: HANDED_WITHIN_MS }).toBe('handled');
    expect(sessionOf(machine, 'scout').starts()).toHaveLength(2);
    await expect(fleet.leasesOf(shipId)).resolves.toBe(1);
  });

  it("is taken over by today's trierarch once its session is idle, and the session goes on with its messages", async () => {
    const shipId = await takenOver(TRIERARCH_UNDER_TEST, TODAYS_TRIERARCH);

    const messageId = await fleet.send('scout', 'Review PR 12 and say what you found');

    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: HANDED_WITHIN_MS }).toBe('handled');
    expect(sessionOf(machine, 'scout').starts()).toHaveLength(2);
    await expect(fleet.leasesOf(shipId)).resolves.toBe(1);
  });
});
