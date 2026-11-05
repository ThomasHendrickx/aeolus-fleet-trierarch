import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// A machine whose session starts keep failing stops offering itself (docs/trierarch.md, "Crewing a ship", aeolus-fleet#853): once the last start of 3 different ships failed with no start succeeding since, it offers no harness and no place, and tells argo once.

const REPORTED_WITHIN_MS = 30_000;
/** Long enough for a pass or two of a trierarch that restarted. */
const PASSES_MS = 12_000;
const STOPPED_HEADLINE = 'Session starts fail here: this machine takes no new ships';

let fleet: Fleet;
let machine: Machine;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
  await aCrewingMachine({ fleet, machine });
  // Every session refuses the model its harness picked: a failed start of the machine's, never of one ship's settings.
  machine.refuseModel('claude-opus-5');
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

const detailsSchema = z.looseObject({
  harnesses: z.array(z.looseObject({ harness: z.string() })),
  workspaces: z.looseObject({ repositories: z.array(z.string()), folders: z.array(z.string()) }),
  notOffered: z.array(z.looseObject({ harness: z.string(), reason: z.string() })).optional(),
});

/** What the trierarch's last report offers. */
async function offered() {
  const report = await fleet.reportOfTrierarch();
  return report === undefined ? undefined : { note: report.note, details: detailsSchema.parse(report.details) };
}

/** The starts of the named ships fail, each refused by its session. */
async function failedStarts(names: readonly string[]): Promise<void> {
  const shipIds: ShipId[] = [];
  for (const name of names) {
    const shipId = await fleet.commission(name);
    await fleet.crewInWorktree(shipId, { repository: REPOSITORY, harness: 'claude-code' });
    shipIds.push(shipId);
  }
  for (const shipId of shipIds) {
    await expect.poll(() => fleet.givenBackReasonOf(shipId), { timeout: REPORTED_WITHIN_MS }).toContain('refused claude-opus-5');
  }
}

/** Argo's notices that the machine stopped offering itself. */
async function toldStopped() {
  return (await fleet.toldByTrierarch()).filter((told) => told.to === 'argo' && told.text.startsWith(STOPPED_HEADLINE));
}

describe('a machine whose session starts keep failing', () => {
  it('offers no harness and no place once the starts of 3 ships failed in a row, naming each harness with the first reason, and says so in its note', async () => {
    await failedStarts(['scout', 'lookout', 'helm']);

    await expect.poll(async () => (await offered())?.details.harnesses, { timeout: REPORTED_WITHIN_MS }).toEqual([]);
    const report = await offered();
    expect(report?.details.workspaces).toEqual({ repositories: [], folders: [] });
    expect(report?.details.notOffered?.map(({ harness }) => harness)).toEqual(['claude-code']);
    expect(report?.details.notOffered?.[0]?.reason).toMatch(/^the starts of 3 ships failed in a row; first: claude-code .*refused claude-opus-5; it offers itself again at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(report?.note).toContain(', not offered: the starts of 3 ships failed in a row');
  });

  it('tells argo once, with the first reason and how it offers itself again', async () => {
    await failedStarts(['scout', 'lookout', 'helm']);
    await expect.poll(async () => (await toldStopped()).length, { timeout: REPORTED_WITHIN_MS }).toBe(1);

    await failedStarts(['bosun']);
    await wait(PASSES_MS);

    const told = await toldStopped();
    expect(told).toHaveLength(1);
    expect(told[0]?.text).toContain('- Failed in a row: the starts of 3 ships');
    expect(told[0]?.text).toMatch(/- First: claude-code .*refused claude-opus-5/);
    expect(told[0]?.text).toContain('It offers itself again for one start 10 minutes after its last failed start');
  });

  it('still offers itself after the starts of 2 ships failed', async () => {
    await failedStarts(['scout', 'lookout']);
    await wait(PASSES_MS);

    expect((await offered())?.details.harnesses.map(({ harness }) => harness)).toEqual(['claude-code']);
    expect((await offered())?.details.notOffered).toBeUndefined();
    await expect(toldStopped()).resolves.toEqual([]);
  });

  it('keeps not offering itself across a restart of the trierarch with the same configuration', async () => {
    await failedStarts(['scout', 'lookout', 'helm']);
    await expect.poll(async () => (await offered())?.details.harnesses, { timeout: REPORTED_WITHIN_MS }).toEqual([]);

    const restart = await machine.trierarch(['restart']);
    await wait(PASSES_MS);

    expect(restart.status, restart.stdout + restart.stderr).toBe(0);
    expect((await offered())?.details.harnesses).toEqual([]);
    await expect(toldStopped()).resolves.toHaveLength(1);
  });

  it('offers itself again once the trierarch starts with a changed configuration', async () => {
    await failedStarts(['scout', 'lookout', 'helm']);
    await expect.poll(async () => (await offered())?.details.harnesses, { timeout: REPORTED_WITHIN_MS }).toEqual([]);
    const notes = join(machine.home, 'notes');
    mkdirSync(notes);
    const added = await machine.trierarch(['add', 'folder', 'notes', notes]);
    expect(added.status, added.stdout + added.stderr).toBe(0);

    const restart = await machine.trierarch(['restart']);

    expect(restart.status, restart.stdout + restart.stderr).toBe(0);
    await expect.poll(async () => (await offered())?.details.harnesses.map(({ harness }) => harness), { timeout: REPORTED_WITHIN_MS }).toEqual(['claude-code']);
  });
});
