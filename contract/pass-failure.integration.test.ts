import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// A pass that cannot read what it reconciles is kept in the state with its reason and since when, across the passes that fail after it (docs/trierarch.md, "Lifecycles").

/** A pass runs every 5 seconds. */
const FAILS_WITHIN_MS = 30_000;
const PASSES_MS = 12_000;

const stateSchema = z.object({ passFailure: z.object({ reason: z.string().min(1), since: z.string() }).optional() });

let fleet: Fleet;
let machine: Machine;

const passFailure = () => stateSchema.parse(JSON.parse(readFileSync(join(machine.trierarchHome, 'state.json'), 'utf8'))).passFailure;

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

describe('a pass that cannot read what it reconciles', () => {
  it('is kept in the state with its reason', async () => {
    await fleet.close();

    await expect.poll(passFailure, { timeout: FAILS_WITHIN_MS }).toBeDefined();
    expect(passFailure()?.reason).not.toBe('');
    expect(machine.serviceLog()).toMatch(/The pass failed: .+; the next pass tries again; aeolus-trierarch status and list show where it stands/);
  });

  it('keeps since when the passes after it fail too', async () => {
    await fleet.close();
    await expect.poll(passFailure, { timeout: FAILS_WITHIN_MS }).toBeDefined();
    const first = passFailure();

    await wait(PASSES_MS);

    expect(passFailure()?.since).toBe(first?.since);
    expect(new Date(first?.since ?? '').toString()).not.toBe('Invalid Date');
  });
});
