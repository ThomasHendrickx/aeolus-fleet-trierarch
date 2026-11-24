import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, crash, listedEntryOf, REPOSITORY, sessionOf, setupLineOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';
import { PASS_INTERVAL_MS, PRODUCTION_FIRST_RESTART_DELAY_MS, PRODUCTION_INIT_STABILITY_MS, PRODUCTION_PASS_INTERVAL_MS, type Timings } from './support/timings.js';

// The rest of the suite runs the trierarch at shortened timings (support/timings.ts); these tests hold each timing it shortens to its
// production value (docs/timings-and-limits.md), and one holds the shortened pass interval, which proves the setting reaches the service.

/** How much later than its timing a pass or init's return may come, for the work of a pass and init's polls: under a second, so a timing a second longer fails. */
const LATE_BY_AT_MOST_MS = 1_000;
const CREWED_WITHIN_MS = 30_000;
/** How often the tests look at the trierarch's files. */
const LOOK_EVERY_MS = 50;

let fleet: Fleet | undefined;
let machine: Machine | undefined;

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail' && machine !== undefined) {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine?.remove();
  await fleet?.close();
  machine = undefined;
  fleet = undefined;
});

async function aCrewingMachineAt(timings: Timings): Promise<{ fleet: Fleet; machine: Machine }> {
  fleet = await aFleet();
  machine = await aMachine({ timings });
  await aCrewingMachine({ fleet, machine });
  return { fleet, machine };
}

/** Starts a single service for timing its passes, without the repository setup that restarts it. */
async function aMachineForPassTimings(timings: Timings): Promise<Machine> {
  fleet = await aFleet();
  machine = await aMachine({ timings });
  const ran = await machine.trierarch(setupLineOf(fleet), { input: fleet.trierarchShip.secret });
  expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
  return machine;
}

const seenSchema = z.object({ passAt: z.string() });

/** The time of the last pass the trierarch saw through, none before its first. */
function lastPassAt(on: Machine): number | undefined {
  const file = join(on.trierarchHome, 'seen.json');
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    return Date.parse(seenSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).passAt);
  } catch {
    // Read while the trierarch writes it: the next look reads it whole.
    return undefined;
  }
}

/** The time between each of the next passes and the one before it. */
async function gapsBetweenPasses(on: Machine, count: number): Promise<number[]> {
  const passes: number[] = [];
  while (passes.length < count + 1) {
    const at = lastPassAt(on);
    if (at !== undefined && at !== passes.at(-1)) {
      passes.push(at);
    }
    await wait(LOOK_EVERY_MS);
  }
  return passes.slice(1).map((at, index) => at - (passes[index] ?? at));
}

const savedSchema = z.object({ entries: z.record(z.string(), z.looseObject({ exits: z.array(z.string()).optional(), restartAt: z.string().optional() })) });

/** The ship's saved entry, as the trierarch keeps it. */
function savedEntryOf(on: Machine, shipId: string): { exits?: string[] | undefined; restartAt?: string | undefined } | undefined {
  const file = join(on.trierarchHome, 'state.json');
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    return savedSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).entries[shipId];
  } catch {
    // Read while the trierarch writes it: the next look reads it whole.
    return undefined;
  }
}

describe('at its production timings, the trierarch', () => {
  it('has init wait 10 s for one stable service process before it reports success', async () => {
    fleet = await aFleet();
    machine = await aMachine({ timings: 'production' });

    const ran = await machine.trierarch(setupLineOf(fleet), { input: fleet.trierarchShip.secret });
    const reportedAt = Date.now();

    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    const serviceStartedAt = statSync(join(machine.machine, 'systemd', 'pid')).mtimeMs;
    const waited = reportedAt - serviceStartedAt;
    expect(waited).toBeGreaterThanOrEqual(PRODUCTION_INIT_STABILITY_MS);
    expect(waited).toBeLessThan(PRODUCTION_INIT_STABILITY_MS + LATE_BY_AT_MOST_MS);
  });

  it('runs its passes 5 s apart', async () => {
    const crewing = await aMachineForPassTimings('production');

    expect(crewing.serviceLog().match(/runs as pid/g)).toHaveLength(1);
    for (const gap of await gapsBetweenPasses(crewing, 2)) {
      expect(gap).toBeGreaterThanOrEqual(PRODUCTION_PASS_INTERVAL_MS);
      expect(gap).toBeLessThan(PRODUCTION_PASS_INTERVAL_MS + LATE_BY_AT_MOST_MS);
    }
  });

  it('first restarts a session that died 5 s after it saw it end', async () => {
    const { fleet: at, machine: crewing } = await aCrewingMachineAt('production');
    const scout = await at.commission('scout');
    const session = sessionOf(crewing, 'scout');
    await at.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
    await expect.poll(async () => (await listedEntryOf(crewing, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');

    crash(session.starts()[0]);

    await expect.poll(() => savedEntryOf(crewing, scout)?.restartAt, { timeout: CREWED_WITHIN_MS }).toBeDefined();
    const entry = savedEntryOf(crewing, scout);
    const endedAt = Date.parse(entry?.exits?.at(-1) ?? '');
    const restartAt = Date.parse(entry?.restartAt ?? '');
    expect(restartAt - endedAt).toBe(PRODUCTION_FIRST_RESTART_DELAY_MS);
    await expect.poll(() => session.starts().length, { timeout: CREWED_WITHIN_MS }).toBe(2);
    expect(Date.now()).toBeGreaterThanOrEqual(restartAt);
  });
});

describe("at the suite's shortened timings, the trierarch", () => {
  it('runs its passes the shortened pass interval apart', async () => {
    const crewing = await aMachineForPassTimings('shortened');

    for (const gap of await gapsBetweenPasses(crewing, 2)) {
      expect(gap).toBeGreaterThanOrEqual(PASS_INTERVAL_MS);
      expect(gap).toBeLessThan(PASS_INTERVAL_MS + LATE_BY_AT_MOST_MS);
    }
  });
});
