import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// A crew request's settings are checked again before crewing (docs/trierarch.md): the harness must trust the repository or folder (#381), and no flag the session launches with may wait on a one-time question (#403); one folder crews one ship.

const GIVEN_BACK_WITHIN_MS = 30_000;
const CREWED_WITHIN_MS = 30_000;
const SKIP_PERMISSIONS = '--dangerously-skip-permissions';

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

/** Rewrites Claude Code's .claude.json so it trusts exactly the folders given. */
function claudeTrusts(...folders: readonly string[]): void {
  const file = join(machine.home, '.claude.json');
  const claude = z.looseObject({}).parse(JSON.parse(readFileSync(file, 'utf8')));
  writeFileSync(file, JSON.stringify({ ...claude, projects: Object.fromEntries(folders.map((folder) => [folder, { hasTrustDialogAccepted: true }])) }));
}

async function aFolder(name: string): Promise<void> {
  const path = join(machine.home, name);
  mkdirSync(path);
  const added = await machine.trierarch(['add', 'folder', name, path]);
  expect(added.status, added.stdout + added.stderr).toBe(0);
}

/** Gives Claude Code the skip-permissions flag, with Claude Code's user settings as text says. */
async function claudeLaunchesSkippingPermissions(settingsText: string): Promise<string> {
  const file = join(machine.trierarchHome, 'config.json');
  const configuration = z.looseObject({ harnesses: z.record(z.string(), z.looseObject({})) }).parse(JSON.parse(readFileSync(file, 'utf8')));
  const claudeCode = { ...configuration.harnesses['claude-code'], flags: [SKIP_PERMISSIONS] };
  writeFileSync(file, JSON.stringify({ ...configuration, harnesses: { ...configuration.harnesses, 'claude-code': claudeCode } }));
  const settings = join(machine.home, '.claude', 'settings.json');
  mkdirSync(join(machine.home, '.claude'), { recursive: true });
  writeFileSync(settings, settingsText);
  const restarted = await machine.trierarch(['restart']);
  expect(restarted.status, restarted.stdout + restarted.stderr).toBe(0);
  return settings;
}

/** Claude Code's user settings as a plugin install left them in #393: its own entries only. */
const REWRITTEN_BY_A_PLUGIN_INSTALL = { extraKnownMarketplaces: { 'aeolus-fleet': { source: { source: 'github', repo: 'ThomasHendrickx/aeolus-fleet-trierarch' } } }, enabledPlugins: { 'aeolus-fleet@aeolus-fleet': true } };

describe('a crew request the harness may not start a session for', () => {
  let scout: ShipId;

  beforeEach(async () => {
    scout = await fleet.commission('scout');
  });

  it('in a repository it does not trust is given back, saying to add it with init', async () => {
    claudeTrusts();

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain(`workspace.main.repository: claude-code does not trust the repository ${REPOSITORY}: add it with aeolus-trierarch init, which trusts it`);
    expect(sessionOf(machine, 'scout').starts()).toEqual([]);
  });

  it('in a folder it does not trust is given back, saying to add it with init', async () => {
    await aFolder('notes');
    claudeTrusts(machine.repository);

    await fleet.crewInFolder(scout, { folder: 'notes', harness: 'claude-code' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain('workspace.name: claude-code does not trust the folder notes: add it with aeolus-trierarch init, which trusts it');
  });

  it('with a flag whose acceptance its settings cannot take is given back, saying so', async () => {
    await claudeLaunchesSkippingPermissions('nope');

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain(`harness: claude-code still asks to accept ${SKIP_PERMISSIONS}: its settings could not take the acceptance, make them a JSON object the trierarch can write`);
    expect(sessionOf(machine, 'scout').starts()).toEqual([]);
  });

  it('in a folder another ship crews is given back: one folder crews one ship', async () => {
    await aFolder('notes');
    const lookout = await fleet.commission('lookout');
    await fleet.crewInFolder(lookout, { folder: 'notes', harness: 'claude-code' });
    await expect.poll(() => fleet.leasesOf(lookout), { timeout: GIVEN_BACK_WITHIN_MS }).toBe(1);

    await fleet.crewInFolder(scout, { folder: 'notes', harness: 'claude-code' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain(`workspace.name: The folder notes crews ${lookout} already: one folder crews one ship`);
  });
});

// The skip-permissions flag in the configuration is the operator's consent to bypass permissions mode (#393).
describe('a crew request on Claude Code with the skip-permissions flag', () => {
  it('is crewed where bypass permissions mode was never accepted, which the trierarch accepts', async () => {
    const settings = await claudeLaunchesSkippingPermissions(JSON.stringify(REWRITTEN_BY_A_PLUGIN_INSTALL));
    const scout = await fleet.commission('scout');

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ ...REWRITTEN_BY_A_PLUGIN_INSTALL, skipDangerousModePermissionPrompt: true });
  });

  it('is crewed after a plugin install rewrote the settings without the acceptance (#393)', async () => {
    const settings = await claudeLaunchesSkippingPermissions(JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    const lookout = await fleet.commission('lookout');
    await fleet.crewInRepositories(lookout, { main: REPOSITORY, harness: 'claude-code' });
    await expect.poll(() => sessionOf(machine, 'lookout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    writeFileSync(settings, JSON.stringify(REWRITTEN_BY_A_PLUGIN_INSTALL));

    const scout = await fleet.commission('scout');
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ ...REWRITTEN_BY_A_PLUGIN_INSTALL, skipDangerousModePermissionPrompt: true });
  });
});
