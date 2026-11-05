import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// A request for a harness the machine does not offer, whose aeolus-fleet plugin is missing or marks no launches (#490, #1212, CC3), is given back with why (docs/trierarch.md). Copilot is the harness whose plugin the machine installs itself, so a test can take it away.

const GIVEN_BACK_WITHIN_MS = 30_000;

let fleet: Fleet;
let machine: Machine;
let scout: ShipId;

const configurationSchema = z.looseObject({ harnesses: z.record(z.string(), z.unknown()) });

/** Where the machine's Copilot keeps its aeolus-fleet plugin. */
function installedCopilotPlugin(): string {
  return join(machine.home, '.copilot', 'installed-plugins', 'aeolus-fleet', 'aeolus-fleet');
}

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine({ others: ['copilot'] });
  await aCrewingMachine({ fleet, machine });
  const file = join(machine.trierarchHome, 'config.json');
  const configuration = configurationSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  writeFileSync(file, JSON.stringify({ ...configuration, harnesses: { ...configuration.harnesses, copilot: { flags: [], options: {} } } }));
  const restarted = await machine.trierarch(['restart']);
  expect(restarted.status, restarted.stdout + restarted.stderr).toBe(0);
  scout = await fleet.commission('scout');
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

describe('a crew request for a harness that cannot mark launches', () => {
  it('whose plugin is not installed is given back, saying the machine does not offer it', async () => {
    rmSync(installedCopilotPlugin(), { force: true, recursive: true });

    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'copilot' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain('harness: copilot is not offered: its aeolus-fleet plugin is not installed for Copilot: copilot plugin install aeolus-fleet@aeolus-fleet');
    expect(sessionOf(machine, 'scout').starts()).toEqual([]);
  });

  it("whose plugin is older than the launch marker is given back, saying to run upgrade", async () => {
    // A plugin whose identity script answers `launch` with its usage, as one older than the launch marker does.
    const scripts = join(installedCopilotPlugin(), 'scripts');
    rmSync(installedCopilotPlugin(), { force: true, recursive: true });
    mkdirSync(scripts, { recursive: true });
    const identity = join(scripts, 'aeolus-identity.sh');
    writeFileSync(identity, "#!/usr/bin/env bash\necho 'usage: aeolus-identity.sh write|show' >&2\nexit 2\n");
    chmodSync(identity, 0o755);

    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'copilot' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain("harness: copilot's aeolus-fleet plugin marks no launches: run aeolus-trierarch upgrade");
    expect(sessionOf(machine, 'scout').starts()).toEqual([]);
  });
});
