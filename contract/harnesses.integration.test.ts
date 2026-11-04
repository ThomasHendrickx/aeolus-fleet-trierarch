import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, listedEntryOf, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine, type OtherHarness } from './support/machine.js';

// Each harness the trierarch crews a ship with, besides Claude Code: Codex and Copilot, headless on the host (docs/architecture.md, "First adapters").

const CREWED_WITHIN_MS = 30_000;

let fleet: Fleet;
let machine: Machine;

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

async function aMachineWith(other: OtherHarness): Promise<void> {
  fleet = await aFleet();
  machine = await aMachine({ others: [other] });
  await aCrewingMachine({ fleet, machine });
}

/** Crews scout with the harness and waits until the trierarch lists it running: its session's starts. */
async function aRunningScoutOn(harness: string) {
  const scout = await fleet.commission('scout');
  await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness });
  await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
  return { scout, starts: sessionOf(machine, 'scout').starts() };
}

const configurationSchema = z.looseObject({ harnesses: z.record(z.string(), z.unknown()) });

describe('Codex', () => {
  it('is offered by init where Codex is installed and signed in', async () => {
    await aMachineWith('codex');

    const configuration = configurationSchema.parse(JSON.parse(readFileSync(join(machine.trierarchHome, 'config.json'), 'utf8')));

    expect(Object.keys(configuration.harnesses)).toEqual(expect.arrayContaining(['claude-code', 'codex']));
  });

  it("crews a ship with Codex: codex exec in its worktree, and the fleet keeps codex as its lease's harness", async () => {
    await aMachineWith('codex');

    const { scout, starts } = await aRunningScoutOn('codex');

    expect(starts[0]?.args).toEqual(expect.arrayContaining(['exec', '--json']));
    await expect(fleet.leaseHarnessOf(scout)).resolves.toBe('codex');
  });

  it("hands a message to a Codex ship's idle session: a turn of its own holds it, and the delivery ends handled", async () => {
    await aMachineWith('codex');
    await aRunningScoutOn('codex');

    const messageId = await fleet.send('scout', 'Review PR 12 and say what you found');

    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: CREWED_WITHIN_MS }).toBe('handled');
    expect(sessionOf(machine, 'scout').turns().map((turn) => turn.context).join('\n')).toContain('Review PR 12 and say what you found');
  });
});

describe('Copilot', () => {
  it("crews a ship with Copilot once the configuration offers it: copilot in its worktree, and the fleet keeps copilot as its lease's harness", async () => {
    await aMachineWith('copilot');
    const file = join(machine.trierarchHome, 'config.json');
    const configuration = configurationSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    writeFileSync(file, JSON.stringify({ ...configuration, harnesses: { ...configuration.harnesses, copilot: { flags: [], options: {} } } }));
    const restart = await machine.trierarch(['restart']);
    expect(restart.status, restart.stdout + restart.stderr).toBe(0);

    const { scout, starts } = await aRunningScoutOn('copilot');

    expect(starts[0]?.args).toEqual(expect.arrayContaining(['--output-format=json']));
    await expect(fleet.leaseHarnessOf(scout)).resolves.toBe('copilot');
  });
});
