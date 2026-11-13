import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aCrewingMachine, listedEntryOf, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// What each running session's latest event says it is doing is written each pass, with the interval 30 seconds, so the fleet reads a down trierarch as unknown (docs/design/monitoring, 4.3).

const CREWED_WITHIN_MS = 30_000;
const WRITTEN_WITHIN_MS = 30_000;

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

describe("a running session's activity", () => {
  it('is written with the interval 30 seconds, as its latest event says: a turn that ended well is a result', async () => {
    const scout = await fleet.commission('scout');
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');

    await expect.poll(() => fleet.activityOf(scout), { timeout: WRITTEN_WITHIN_MS }).toEqual({ kind: 'result', tool: null, intervalSeconds: 30 });
  });
});
