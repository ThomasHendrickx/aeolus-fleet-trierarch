import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, listedEntryOf, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, PLUGIN_ROOT, type Machine } from './support/machine.js';
import { isTodaysTrierarch } from './support/trierarch-under-test.js';

// `aeolus-trierarch status` says the whole state, and `status` and `list` colour their words where a person reads a colour terminal (docs/trierarch.md, "Commands").

/** A pass runs every 5 seconds. */
const CREWED_WITHIN_MS = 30_000;
const FAILS_WITHIN_MS = 30_000;

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

const reportSchema = z.object({
  version: z.string(),
  runningVersion: z.string().optional(),
  plugins: z.record(z.string(), z.string().nullable()),
  repositories: z.array(z.string()),
  service: z.object({ file: z.string(), isInstalled: z.boolean(), isRunning: z.boolean(), pid: z.number().optional(), since: z.string().optional() }),
  fleet: z.object({ url: z.string(), shipId: z.string(), lease: z.string() }),
  caps: z.object({ ships: z.object({ used: z.number(), cap: z.number() }), running: z.object({ used: z.number(), cap: z.number() }) }),
  entries: z.record(z.string(), z.number()),
  kept: z.array(z.object({ shipId: z.string(), repository: z.string(), path: z.string() })),
  orphans: z.array(z.string()),
  passFailure: z.object({ reason: z.string(), since: z.string() }).optional(),
});

async function statusReport() {
  const ran = await machine.trierarch(['status', '--json']);
  expect(ran.status, ran.stdout + ran.stderr).toBe(0);
  return reportSchema.parse(JSON.parse(ran.stdout));
}

async function statusText(env: Readonly<Record<string, string>> = {}): Promise<string> {
  const ran = await machine.trierarch(['status'], { env });
  expect(ran.status, ran.stdout + ran.stderr).toBe(0);
  return ran.stdout;
}

const pluginVersion = (): string => z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))).version;
const configuration = () => z.object({ caps: z.object({ ships: z.number(), running: z.number() }) }).parse(JSON.parse(readFileSync(join(machine.trierarchHome, 'config.json'), 'utf8')));
const stateFile = () => join(machine.trierarchHome, 'state.json');

async function aRunningScout(): Promise<void> {
  await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });
  await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
}

/** Stops the service, which leaves the sessions running, and changes the state it saved. */
async function withState(change: (state: Record<string, unknown>) => void): Promise<void> {
  const stopped = await machine.trierarch(['stop']);
  expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
  const state = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(stateFile(), 'utf8')));
  change(state);
  writeFileSync(stateFile(), JSON.stringify(state));
}

describe('status', () => {
  it('says the version, the plugin per harness, the repositories, the service, the fleet and its lease, the caps in use and the entries by state', async () => {
    await aRunningScout();
    const version = z.object({ version: z.string() }).parse(JSON.parse((await machine.trierarch(['--version', '--json'])).stdout)).version;

    const report = await statusReport();

    expect(report).toMatchObject({
      version,
      runningVersion: version,
      plugins: { 'claude-code': pluginVersion() },
      repositories: [REPOSITORY],
      service: { isInstalled: true, isRunning: true, pid: machine.servicePid() },
      fleet: { url: fleet.url, shipId: fleet.trierarchShip.shipId, lease: 'valid' },
      caps: { ships: { used: 1, cap: configuration().caps.ships }, running: { used: 1, cap: configuration().caps.running } },
      entries: { crewing: 0, running: 1, restarting: 0, crashed: 0, releasing: 0 },
      kept: [],
      orphans: [],
    });
    expect(new Date(report.service.since ?? '').toString()).not.toBe('Invalid Date');
    expect(report.passFailure).toBeUndefined();
  });

  it('says each in a line of its label', async () => {
    await aRunningScout();
    const report = await statusReport();

    // How long it runs is read from the process in whole seconds, so `since` may differ between two calls.
    // When the models were confirmed is the time of the machine's detection.
    const lines = (await statusText())
      .split('\n')
      .map((line) => line.replace(/(?<=^Service: .*since ).+$/, '<since>').replace(/(?<=^Models confirmed: claude-code ).+$/, '<confirmed>'));

    expect(lines).toEqual([
      `Version: ${report.version}`,
      `Aeolus Fleet plugin: claude-code ${pluginVersion()}`,
      // Today's trierarch, kept for existing machines, does not say when the models were confirmed.
      ...(isTodaysTrierarch ? [] : ['Models confirmed: claude-code <confirmed>']),
      `Repositories: ${REPOSITORY}`,
      `Service: running, pid ${String(report.service.pid)}, since <since>`,
      `Fleet: ${fleet.url}, the lease of ${fleet.trierarchShip.shipId} is valid`,
      `Caps: 1 of ${String(report.caps.ships.cap)} ships crewed here, 1 of ${String(report.caps.running.cap)} sessions running`,
      'Last pass: succeeded',
      'Entries: running 1',
      'Kept worktrees: none',
      'Orphans: none',
      '',
    ]);
  });

  it('says that the service is installed and not running, and what to do', async () => {
    await machine.trierarch(['stop']);

    const report = await statusReport();

    expect(report.service).toMatchObject({ isInstalled: true, isRunning: false });
    expect(report.runningVersion).toBeUndefined();
    expect(await statusText()).toContain('Service: installed, not running (aeolus-trierarch start)\n');
  });

  it('says the entries of every state, the kept worktrees and the orphans the state holds', async () => {
    await aRunningScout();
    await withState((state) => {
      const entries = z.record(z.string(), z.record(z.string(), z.unknown())).parse(state.entries);
      const [id = '', entry = {}] = Object.entries(entries)[0] ?? [];
      // Two other ships' ids, which differ from the ship's by their last character.
      const [restarting = '', crashed = ''] = ['0', '1', '2'].filter((last) => !id.endsWith(last)).map((last) => `${id.slice(0, -1)}${last}`);
      state.entries = { ...entries, [restarting]: { ...entry, shipId: restarting, state: 'restarting' }, [crashed]: { ...entry, shipId: crashed, state: 'crashed' } };
      state.kept = [{ shipId: scout, repository: REPOSITORY, path: '/worktrees/aeolus-fleet/scout' }];
      state.orphans = [{ path: '/worktrees/aeolus-fleet/stray', repository: REPOSITORY, name: 'stray' }];
    });

    const report = await statusReport();
    const text = await statusText();

    expect(report.entries).toEqual({ crewing: 0, running: 1, restarting: 1, crashed: 1, releasing: 0 });
    expect(report.kept).toEqual([{ shipId: scout, repository: REPOSITORY, path: '/worktrees/aeolus-fleet/scout' }]);
    expect(report.orphans).toEqual(['/worktrees/aeolus-fleet/stray']);
    expect(report.caps.ships.used).toBe(3);
    expect(text).toContain('Entries: running 1, restarting 1, crashed 1\n');
    expect(text).toContain(`Kept worktrees: /worktrees/aeolus-fleet/scout (${scout})\n`);
    expect(text).toContain('Orphans: /worktrees/aeolus-fleet/stray\n');
  });

  it('says why the last pass failed and since when', async () => {
    await withState((state) => {
      state.passFailure = { reason: 'the fleet cannot be reached', since: '2026-10-06T08:00:00.000Z' };
    });

    const report = await statusReport();

    expect(report.passFailure).toEqual({ reason: 'the fleet cannot be reached', since: '2026-10-06T08:00:00.000Z' });
    expect(await statusText()).toContain('Last pass: failing since 2026-10-06T08:00:00.000Z: the fleet cannot be reached\n');
  });

  it("says the trierarch's lease ended once its ship was released", async () => {
    await fleet.database.lease.updateMany({ where: { shipId: fleet.trierarchShip.shipId, endedAt: null }, data: { endedAt: new Date() } });

    expect((await statusReport()).fleet.lease).toBe('ended');
    expect(await statusText()).toContain(`the lease of ${fleet.trierarchShip.shipId} ended: its ship was released or retired, so it crews nothing\n`);
  });

  it('says the fleet cannot be reached, and the passes that fail since', async () => {
    await fleet.close();

    expect((await statusReport()).fleet.lease).toBe('unreachable');
    expect(await statusText()).toContain(`Fleet: ${fleet.url} cannot be reached\n`);
    await expect.poll(async () => (await statusReport()).passFailure, { timeout: FAILS_WITHIN_MS }).toBeDefined();
  });

  it("says the harnesses in the configuration file's order, not alphabetically", async () => {
    const config = join(machine.trierarchHome, 'config.json');
    const written = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(config, 'utf8')));
    writeFileSync(config, JSON.stringify({ ...written, harnesses: { copilot: { flags: [], options: {} }, ...z.record(z.string(), z.unknown()).parse(written.harnesses) } }));

    expect(await statusText()).toContain(`Aeolus Fleet plugin: copilot not found (install the aeolus-fleet plugin for it), claude-code ${pluginVersion()}\n`);
  });

  it('says the plugin a configured harness has none of', async () => {
    const config = join(machine.trierarchHome, 'config.json');
    const written = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(config, 'utf8')));
    writeFileSync(config, JSON.stringify({ ...written, harnesses: { ...z.record(z.string(), z.unknown()).parse(written.harnesses), copilot: { flags: [], options: {} } } }));

    expect((await statusReport()).plugins).toEqual({ 'claude-code': pluginVersion(), copilot: null });
    expect(await statusText()).toContain(`Aeolus Fleet plugin: claude-code ${pluginVersion()}, copilot not found (install the aeolus-fleet plugin for it)\n`);
  });
});

describe('colour', () => {
  const COLOUR = { FORCE_COLOR: '1' };
  const ESCAPE = String.fromCharCode(27);

  it('colours status on a colour terminal, saying the same words as in plain text', async () => {
    const plain = await statusText();

    const coloured = await statusText(COLOUR);

    expect(coloured).toContain(`${ESCAPE}[`);
    expect(coloured).toContain(`${ESCAPE}[1mVersion:${ESCAPE}[22m`);
    expect(coloured).toContain(`${ESCAPE}[32mrunning${ESCAPE}[39m`);
    expect(stripVTControlCharacters(coloured).replace(/since [^\n]+/, '')).toBe(plain.replace(/since [^\n]+/, ''));
  });

  it('colours list on a colour terminal: the header strong and each state in its tone', async () => {
    await aRunningScout();
    const plain = (await machine.trierarch(['list'])).stdout;

    const coloured = (await machine.trierarch(['list'], { env: COLOUR })).stdout;

    expect(coloured).toContain(`${ESCAPE}[1mSHIP`);
    expect(coloured).toContain(`${ESCAPE}[32mrunning${ESCAPE}[39m`);
    expect(stripVTControlCharacters(coloured)).toBe(plain);
  });

  it('colours nothing under --json, nor where a pipe or NO_COLOR says so', async () => {
    await aRunningScout();

    const json = await machine.trierarch(['status', '--json'], { env: COLOUR });
    const listed = await machine.trierarch(['list', '--json'], { env: COLOUR });
    const piped = await machine.trierarch(['list']);
    const refused = await machine.trierarch(['status'], { env: { NO_COLOR: '1' } });

    expect(json.stdout).not.toContain(ESCAPE);
    expect(listed.stdout).not.toContain(ESCAPE);
    expect(piped.stdout).not.toContain(ESCAPE);
    expect(refused.stdout).not.toContain(ESCAPE);
  });
});
