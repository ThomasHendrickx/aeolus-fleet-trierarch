import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aCrewingMachine, sessionOf, isRunning, listedEntryOf, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// run with the reconciler, as the service runs it: what is assigned is crewed, what ends is ended, a session that ended is started again (docs/trierarch.md, "Lifecycles").

/** A pass runs every 5 seconds, and a session that ended first waits 5 seconds before it starts again. */
const CREWED_WITHIN_MS = 30_000;
/** Crews scout and waits until the trierarch lists it running. */
async function aRunningScout(): Promise<void> {
  await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });
  await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
}

/** Long enough for a pass or two of a trierarch that restarted. */
const PASSES_MS = 12_000;

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

describe('run with the reconciler', () => {
  it("crews an assigned request: the ship's lease is held and its session starts in a worktree of the repository", async () => {
    const session = sessionOf(machine, 'scout');

    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => fleet.leasesOf(scout), { timeout: CREWED_WITHIN_MS }).toBe(1);
    await expect.poll(() => session.starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    expect(session.starts()[0]?.args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']));
  });

  it('lists the ship it crews', async () => {
    await aRunningScout();

    const list = await machine.trierarch(['list', '--json']);

    expect(list.status, list.stdout + list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ shipId: scout, harness: 'claude-code' })]);
  });

  it('ends what a removed request held: the lease, the session and its clean worktree', async () => {
    const session = sessionOf(machine, 'scout');
    await aRunningScout();
    const pid = session.starts()[0]?.pid ?? 0;

    await fleet.removeCrewRequest(scout);

    await expect.poll(() => fleet.leasesOf(scout), { timeout: CREWED_WITHIN_MS }).toBe(0);
    await expect.poll(() => isRunning(pid), { timeout: CREWED_WITHIN_MS }).toBe(false);
    await expect.poll(() => existsSync(session.worktree), { timeout: CREWED_WITHIN_MS }).toBe(false);
  });

  it('starts a running session that ended again, in the same worktree', async () => {
    const session = sessionOf(machine, 'scout');
    await aRunningScout();

    // The session the trierarch started for this test ends, by its own pid, as a crash ends it.
    process.kill(session.starts()[0]?.pid ?? 0, 'SIGKILL');

    await expect.poll(() => session.starts().length, { timeout: CREWED_WITHIN_MS }).toBe(2);
    await expect.poll(() => listedEntryOf(machine, scout), { timeout: CREWED_WITHIN_MS }).toMatchObject({ state: 'running', restarts: 1 });
    await expect(fleet.leasesOf(scout)).resolves.toBe(1);
  });

  it('keeps a session running while the trierarch restarts, and does not start it again', async () => {
    const session = sessionOf(machine, 'scout');
    await aRunningScout();
    const before = machine.servicePid();

    const restart = await machine.trierarch(['restart']);
    await wait(PASSES_MS);

    expect(restart.status, restart.stdout + restart.stderr).toBe(0);
    expect(machine.servicePid()).not.toBe(before);
    expect(session.starts()).toHaveLength(1);
    expect(isRunning(session.starts()[0]?.pid ?? 0)).toBe(true);
    await expect(fleet.leasesOf(scout)).resolves.toBe(1);
  });
});

describe('a ship released elsewhere (row 11)', () => {
  it('is crewed again in a fresh worktree as a first start, and argo is told what the old one held', async () => {
    await aRunningScout();
    const session = sessionOf(machine, 'scout');
    const first = session.starts()[0];
    writeFileSync(join(session.worktree, 'notes.txt'), 'unsaved\n');

    await fleet.releaseElsewhere(scout);

    await expect.poll(() => fleet.leasesOf(scout), { timeout: CREWED_WITHIN_MS }).toBe(1);
    await expect.poll(() => existsSync(join(session.worktree, 'notes.txt')) || session.starts().length !== 1, { timeout: CREWED_WITHIN_MS }).toBe(false);
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
    expect(session.starts()).toHaveLength(1);
    expect(session.starts()[0]?.pid).not.toBe(first?.pid);
    expect(session.starts()[0]?.args).not.toContain('--resume');
    await expect.poll(async () => (await fleet.toldByTrierarch()).map((told) => told.text.split('\n')[0]), { timeout: CREWED_WITHIN_MS }).toEqual(['scout released elsewhere: unpushed work discarded']);
    const [told] = await fleet.toldByTrierarch();
    expect(told?.text).toContain('The trierarch removed its worktree before crewing it again.');
    expect(told?.text).toContain('- new `notes.txt`');
  });
});
