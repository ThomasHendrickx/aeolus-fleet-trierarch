import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { setTimeout as wait } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, listedEntryOf, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, CLAUDE_CODE_VERSION, type Machine } from './support/machine.js';

/** Time enough for passes after the one that told, to show a notice told twice. */
const ANOTHER_PASSES_MS = 12_000;

// What the trierarch tells argo and a ship's owner (docs/trierarch.md, "Crashed and Restart", "Crewing a ship", "API keys", "Release"), each in the ship protocol's shape for argo: a headline, a blank line, the facts.

const CREWED_WITHIN_MS = 30_000;
const TOLD_WITHIN_MS = 30_000;

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
    console.log(`Told:\n${JSON.stringify(await fleet.toldByTrierarch(), null, 2)}`);
  }
  await machine.remove();
  await fleet.close();
});

/** Crews the ship in a worktree and waits until the trierarch lists it running. */
async function aRunning(shipId: ShipId, at: { options?: Record<string, string> } = {}): Promise<void> {
  await fleet.crewInRepositories(shipId, { main: REPOSITORY, harness: 'claude-code', ...at });
  await expect.poll(async () => (await listedEntryOf(machine, shipId))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
}

/** Waits until the trierarch told someone and answers what it told them. */
async function told(count: number) {
  await expect.poll(async () => (await fleet.toldByTrierarch()).length, { timeout: TOLD_WITHIN_MS }).toBeGreaterThanOrEqual(count);
  return fleet.toldByTrierarch();
}

const shipFact = (shipId: ShipId, name: string): string => `- Ship: ${name} (\`${shipId}\`)`;

/** The state as the trierarch saves it, but for what the test changes: every other field stays as it was read. */
const savedSchema = z.looseObject({ entries: z.record(z.string(), z.looseObject({ exits: z.array(z.string()), state: z.string(), restartAt: z.string().optional() })) });
type SavedEntry = z.infer<typeof savedSchema>['entries'][string];

/** Stops the service, lets the ship's entry in its state be changed as the five restarts of the last minutes leave it, then starts the service again: the next exit of its session is the sixth. */
async function withFiveRestarts(shipId: ShipId, change: (entry: SavedEntry) => void = () => undefined): Promise<void> {
  await machine.trierarch(['stop']);
  const file = join(machine.trierarchHome, 'state.json');
  const state = savedSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const entry = state.entries[shipId];
  if (entry === undefined) {
    throw new Error(`the state holds no entry of ${shipId}`);
  }
  entry.exits = [5, 4, 3, 2, 1].map((minutes) => new Date(Date.now() - minutes * 60_000).toISOString());
  change(entry);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  await machine.trierarch(['start']);
}

/** The ship's session ended, as a crash ends it. */
function crash(shipName: string): void {
  process.kill(sessionOf(machine, shipName).starts().at(-1)?.pid ?? 0, 'SIGKILL');
}

function crashedAfterSix(shipId: ShipId, at: { tail: string; lastStart?: string }): string {
  const facts = [shipFact(shipId, 'scout'), '- Status: crashed, its restart budget spent', ...(at.lastStart === undefined ? [] : [`- Its last start: ${at.lastStart}`])];
  return ['scout crashed 6 times in an hour', '', ...facts, '', at.tail].join('\n');
}

describe('unpushed work discarded on a release', () => {
  it('logs what the removed worktree held and tells nobody', async () => {
    const scout = await fleet.commission('scout');
    await aRunning(scout);
    const { folder, main } = sessionOf(machine, 'scout');
    writeFileSync(join(main, 'notes.txt'), 'unsaved\n');

    await fleet.removeCrewRequest(scout);

    // The stand-in session writes its own files into its ship folder, which is no repository: only the main repository's change is told.
    await expect.poll(() => machine.serviceLog(), { timeout: CREWED_WITHIN_MS }).toContain(`Discarded from the worktree of scout (${scout}), ${main}: ?? notes.txt`);
    expect(existsSync(folder)).toBe(false);
    await wait(ANOTHER_PASSES_MS);
    await expect(fleet.toldByTrierarch()).resolves.toEqual([]);
  });

  it('tells nobody when the worktree held nothing', async () => {
    const scout = await fleet.commission('scout');
    await aRunning(scout);
    const session = sessionOf(machine, 'scout');
    await machine.trierarch(['stop']);
    for (const name of ['fake-received.jsonl', 'fake-starts.jsonl', 'fake-turns.jsonl']) {
      rmSync(join(session.folder, name), { force: true });
    }
    await machine.trierarch(['start']);

    await fleet.removeCrewRequest(scout);

    await expect.poll(() => fleet.leasesOf(scout), { timeout: CREWED_WITHIN_MS }).toBe(0);
    await wait(ANOTHER_PASSES_MS);
    await expect(fleet.toldByTrierarch()).resolves.toEqual([]);
  });
});

describe('a session crashed', () => {
  it('tells argo when it owns the ship, with the console to restart it in', async () => {
    const scout = await fleet.commission('scout');
    await aRunning(scout);
    await withFiveRestarts(scout);
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');

    crash('scout');

    await expect(told(1)).resolves.toEqual([{ to: 'argo', text: crashedAfterSix(scout, { tail: 'Restart it in the console to crew it again.' }) }]);
    await wait(ANOTHER_PASSES_MS);
    await expect(fleet.toldByTrierarch()).resolves.toHaveLength(1);
  });

  it("tells the ship's owner when a person owns it, saying argo can restart it, and argo nothing", async () => {
    const thomas = await fleet.commission('thomas');
    const scout = await fleet.commission('scout', { owner: thomas });
    await aRunning(scout);
    await withFiveRestarts(scout);
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');

    crash('scout');

    await expect(told(1)).resolves.toEqual([{ to: 'thomas', text: crashedAfterSix(scout, { tail: 'argo can restart it in the console.' }) }]);
    await wait(ANOTHER_PASSES_MS);
    await expect(fleet.toldByTrierarch()).resolves.toHaveLength(1);
  });

  it('tells argo, saying why, when the fleet refuses the report to the owner', async () => {
    const thomas = await fleet.commission('thomas');
    const scout = await fleet.commission('scout', { owner: thomas });
    await aRunning(scout);
    await fleet.closeTheNetwork();
    await withFiveRestarts(scout);
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');

    crash('scout');

    await expect(told(1)).resolves.toEqual([
      { to: 'argo', text: crashedAfterSix(scout, { tail: 'Restart it in the console to crew it again.\n\nIts owner thomas could not be reached: FORBIDDEN: The network rules do not allow this send.' }) },
    ]);
  });

  it('names why its last start failed, when the model it started with was refused', async () => {
    const scout = await fleet.commission('scout');
    await aRunning(scout, { options: { model: 'claude-sonnet-5' } });
    const pid = sessionOf(machine, 'scout').starts().at(-1)?.pid ?? 0;
    await machine.trierarch(['stop']);
    process.kill(pid, 'SIGKILL');
    machine.refuseModel('claude-sonnet-5');
    await machine.trierarch(['start']);
    await withFiveRestarts(scout, (entry) => {
      entry.state = 'restarting';
      entry.restartAt = new Date(Date.now() - 1_000).toISOString();
    });

    const all = await told(2);

    expect(all.map(({ to }) => to)).toEqual(['argo', 'argo']);
    expect(all[1]?.text).toBe(crashedAfterSix(scout, { tail: 'Restart it in the console to crew it again.', lastStart: `claude-code ${CLAUDE_CODE_VERSION} refused claude-sonnet-5` }));
  });
});

describe('a ship whose folder holds no identity', () => {
  it('tells argo it is no longer woken, once per loss', async () => {
    const scout = await fleet.commission('scout');
    await aRunning(scout);

    await machine.removeIdentity(sessionOf(machine, 'scout').folder);

    await expect(told(1)).resolves.toEqual([
      {
        to: 'argo',
        text: [
          'scout is no longer woken: its folder holds no identity',
          '',
          shipFact(scout, 'scout'),
          '',
          'The trierarch can no longer report on its behalf, watch its inbox or wake it. Restart it in the console to crew it again.',
        ].join('\n'),
      },
    ]);
    await wait(ANOTHER_PASSES_MS);
    await expect(fleet.toldByTrierarch()).resolves.toHaveLength(1);
  });
});

describe('a session refused the model it launched with', () => {
  it('tells argo which harness at which version refused which model', async () => {
    const scout = await fleet.commission('scout');
    machine.refuseModel('claude-sonnet-5');

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code', options: { model: 'claude-sonnet-5' } });

    await expect(told(1)).resolves.toEqual([
      {
        to: 'argo',
        text: [
          'claude-code refused the model claude-sonnet-5 for scout',
          '',
          shipFact(scout, 'scout'),
          `- Harness: claude-code ${CLAUDE_CODE_VERSION}`,
          '- Model: claude-sonnet-5',
          '',
          'This machine offers the model no more at this version, until `aeolus-trierarch detect` runs by hand.',
        ].join('\n'),
      },
    ]);
    await wait(ANOTHER_PASSES_MS);
    await expect(fleet.toldByTrierarch()).resolves.toHaveLength(1);
  });
});

describe("a harness's API key that holds its ships back", () => {
  const KEY = 'sk-ant-api03-contract-key-not-real';
  const SINCE = '2026-11-04T10:00:00.000Z';

  /** A ship running on the harness's key, which the vendor took. */
  async function aScoutOnItsKey(): Promise<ShipId> {
    const keys = join(machine.trierarchHome, 'keys');
    mkdirSync(keys, { recursive: true, mode: 0o700 });
    writeFileSync(join(keys, 'claude-code'), KEY, { mode: 0o600 });
    const login = await machine.trierarch(['login', 'claude-code', '--default', 'api-key']);
    expect(login.status, login.stdout + login.stderr).toBe(0);
    const scout = await fleet.commission('scout');
    await aRunning(scout);
    return scout;
  }

  it("tells argo once that the key was refused, since when and which ships wait, and how to give it a new key", async () => {
    const scout = await aScoutOnItsKey();
    const { ino, mtimeMs } = statSync(join(machine.trierarchHome, 'keys', 'claude-code'));

    mkdirSync(join(machine.trierarchHome, 'proxy'), { recursive: true });
    writeFileSync(join(machine.trierarchHome, 'proxy', 'key-states.json'), JSON.stringify({ 'claude-code': { state: 'refused', at: SINCE, keyFile: { ino, mtimeMs } } }));

    await expect(told(1)).resolves.toEqual([
      {
        to: 'argo',
        text: [
          "Claude Code's API key was refused",
          '',
          '- Harness: claude-code',
          `- State: refused by its vendor since ${SINCE}`,
          `- Ships that wait: scout (\`${scout}\`)`,
          '',
          'Give it a new key with aeolus-trierarch login claude-code --api-key.',
        ].join('\n'),
      },
    ]);
    await wait(ANOTHER_PASSES_MS);
    await expect(fleet.toldByTrierarch()).resolves.toHaveLength(1);
  });

  it('tells argo that the harness has no key once its key is removed', async () => {
    const scout = await aScoutOnItsKey();

    const removed = await machine.trierarch(['login', 'claude-code', '--remove-key']);
    expect(removed.status, removed.stdout + removed.stderr).toBe(0);

    await expect(told(1)).resolves.toEqual([
      {
        to: 'argo',
        text: ['Claude Code has no API key', '', '- Harness: claude-code', '- State: no key', `- Ships that wait: scout (\`${scout}\`)`, '', 'Give it one with aeolus-trierarch login claude-code --api-key.'].join('\n'),
      },
    ]);
  });
});
