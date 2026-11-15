import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, describe, expect, it } from 'vitest';

import { aCrewingMachine, listedEntryOf, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// A harness with a subscription window used up is not offered until that window resets (#263, docs/trierarch.md, "What a trierarch reports"): its requests are given back at once, naming the window and when it resets, and it is offered again once it did.

const GIVEN_BACK_WITHIN_MS = 30_000;
const HOUR_S = 3600;

let fleet: Fleet;
let machine: Machine;
let scout: ShipId;

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

/** Starts a machine whose Claude Code says the windows given, as the rate limit event of its print-mode turn does. */
async function aMachineWhoseClaudeCodeSays(windows: Readonly<Record<string, { utilization: number; resetsAt: number }>>): Promise<void> {
  fleet = await aFleet();
  machine = await aMachine();
  machine.streamRateLimitEvent(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: windows } }));
  await aCrewingMachine({ fleet, machine });
  scout = await fleet.commission('scout');
}

/** A time in whole minutes a number of hours ahead, as the event says it (seconds), and as the reason says it. */
function inHours(hours: number): { seconds: number; utc: string } {
  const seconds = Math.floor(Date.now() / 60_000) * 60 + hours * HOUR_S;
  return { seconds, utc: `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` };
}

describe('a harness whose subscription window is used up', () => {
  it('is not offered until it resets: its request is given back at once, naming the weekly window and when it resets, and the reason is reported', async () => {
    const fiveHours = inHours(3);
    const week = inHours(48);
    await aMachineWhoseClaudeCodeSays({ five_hour: { utilization: 1, resetsAt: fiveHours.seconds }, seven_day: { utilization: 1, resetsAt: week.seconds } });

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    const reason = `its weekly subscription window is used up until ${week.utc}`;
    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain(`harness: claude-code is not offered: ${reason}`);
    expect(sessionOf(machine, 'scout').starts()).toEqual([]);
    await expect(fleet.leasesOf(scout)).resolves.toBe(0);
    await expect.poll(async () => (await fleet.reportOfTrierarch())?.details, { timeout: GIVEN_BACK_WITHIN_MS }).toMatchObject({ notOffered: [{ harness: 'claude-code', reason }] });
  });

  it('names the 5-hour window as such while it is the one used up', async () => {
    const fiveHours = inHours(3);
    await aMachineWhoseClaudeCodeSays({ five_hour: { utilization: 1, resetsAt: fiveHours.seconds }, seven_day: { utilization: 0.4, resetsAt: inHours(48).seconds } });

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain(`harness: claude-code is not offered: its 5-hour subscription window is used up until ${fiveHours.utc}`);
  });

  it('is offered while no window is used up', async () => {
    await aMachineWhoseClaudeCodeSays({ five_hour: { utilization: 0.99, resetsAt: inHours(3).seconds }, seven_day: { utilization: 0.4, resetsAt: inHours(48).seconds } });

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: GIVEN_BACK_WITHIN_MS }).toBe('running');
  });
});
