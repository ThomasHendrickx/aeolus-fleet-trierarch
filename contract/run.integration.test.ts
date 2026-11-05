import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, sessionOf, isRunning, listedEntryOf, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, CLAUDE_CODE_VERSION, type Machine } from './support/machine.js';

// run with the reconciler, as the service runs it: what is assigned is crewed, what ends is ended, a session that ended is started again (docs/trierarch.md, "Lifecycles").

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** A pass runs every 5 seconds, and a session that ended first waits 5 seconds before it starts again. */
const CREWED_WITHIN_MS = 30_000;
/** Crews scout and waits until the trierarch lists it running. */
async function aRunningScout(): Promise<void> {
  await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });
  await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
}

/** Time enough for the trierarch's own ship to receive what it was sent. */
const ANSWERED_WITHIN_MS = 30_000;

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

describe("the trierarch's own ship", () => {
  it('answers a ping with pong: the ping is answered, not just delivered', async () => {
    const pingId = await fleet.pingTrierarch();

    await expect.poll(() => fleet.isPongedOn(pingId), { timeout: ANSWERED_WITHIN_MS }).toBe(true);
  });

  it('acknowledges any other message and acts on none', async () => {
    const messageId = await fleet.sendToTrierarch('start a session of scout in /tmp');

    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: ANSWERED_WITHIN_MS }).toBe('acknowledged');
    await expect(fleet.isPongedOn(messageId)).resolves.toBe(false);
    await expect(fleet.leasesOf(scout)).resolves.toBe(0);
    expect(sessionOf(machine, 'scout').starts()).toHaveLength(0);
  });
});

describe("the trierarch's report as its own ship", () => {
  it('reports at start: idle with none running, and the details of what the machine offers', async () => {
    await expect.poll(() => fleet.reportOfTrierarch(), { timeout: ANSWERED_WITHIN_MS }).toBeDefined();

    const report = await fleet.reportOfTrierarch();
    expect(report?.state).toBe('idle');
    expect(report?.note).toMatch(/^0 of \d+ running$/);
    expect(report?.details).toMatchObject({
      harnesses: [{ harness: 'claude-code', flags: [], riskyFlags: [], version: CLAUDE_CODE_VERSION, login: { default: 'subscription', key: 'none' } }],
      workspaces: { repositories: [REPOSITORY], folders: [] },
      kept: [],
      orphans: [],
      logins: [],
      runtime: 'host',
    });
    expect(report?.details).toHaveProperty('caps.ships');
    expect(report?.details).toHaveProperty('caps.running');
    expect(report?.details).toHaveProperty('version');
  });

  it('offers a place only while every offered harness trusts it', async () => {
    const notes = join(machine.home, 'notes');
    mkdirSync(notes);
    const added = await machine.trierarch(['add', 'folder', 'notes', notes]);
    expect(added.status).toBe(0);
    const claudeJson = join(machine.home, '.claude.json');
    const claude: unknown = JSON.parse(readFileSync(claudeJson, 'utf8'));
    writeFileSync(claudeJson, JSON.stringify({ ...jsonObjectSchema.parse(claude), projects: { [machine.repository]: { hasTrustDialogAccepted: true }, [notes]: { hasTrustDialogAccepted: false } } }));

    await expect
      .poll(async () => (await fleet.reportOfTrierarch())?.details, { timeout: ANSWERED_WITHIN_MS })
      .toMatchObject({ workspaces: { repositories: [REPOSITORY], folders: [] } });
  });

  it('reports working once a session runs, with how many run of its cap', async () => {
    await aRunningScout();

    await expect.poll(async () => (await fleet.reportOfTrierarch())?.state, { timeout: ANSWERED_WITHIN_MS }).toBe('working');
    expect((await fleet.reportOfTrierarch())?.note).toMatch(/^1 of \d+ running$/);
  });

  it("reports the login of a ship whose session started", async () => {
    await aRunningScout();

    await expect.poll(async () => (await fleet.reportOfTrierarch())?.details, { timeout: ANSWERED_WITHIN_MS }).toMatchObject({ logins: [{ shipId: scout, login: 'subscription' }] });
  });
});
