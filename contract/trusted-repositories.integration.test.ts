import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// The trusted repositories from the trierarch plugin's ship: asked for, kept, trusted, offered and cloned on demand (docs/trierarch.md, "Trusted repositories").

const LIST_TYPE = 'application/vnd.aeolus.trierarch.trusted-repositories+json';
const REQUEST_TYPE = 'application/vnd.aeolus.trierarch.trusted-repositories-request+json';

/** A pass runs every 5 seconds. */
const ANSWERED_WITHIN_MS = 30_000;

/** The repository's name on the list. */
const TOOLS = 'tools';

let fleet: Fleet;
let machine: Machine;
let plugin: ShipId;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
  plugin = await fleet.commission('trierarch-plugin');
  await aCrewingMachine({ fleet, machine, pluginShip: plugin });
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

/** A repository the machine reaches over ssh: git's ssh stand-in runs the remote command here, so the URL's path is a folder of this computer. */
function anSshRepository(): string {
  const folder = mkdtempSync(join(tmpdir(), 'trierarch-trusted-'));
  execFileSync('git', ['clone', '-q', '--bare', machine.repository, folder]);
  return `ssh://git@origin.example.test${folder}`;
}

const listOf = (repositories: readonly { name: string; url: string }[]): { payload: string; contentType: string } => ({ payload: JSON.stringify({ repositories }), contentType: LIST_TYPE });

const keptSchema = z.object({ repositories: z.array(z.object({ name: z.string(), url: z.string() })) });

const keptFile = (): string => join(machine.trierarchHome, 'trusted-repositories.json');
const keptList = (): unknown => (existsSync(keptFile()) ? JSON.parse(readFileSync(keptFile(), 'utf8')) : undefined);
const cloneOf = (name: string): string => join(machine.trierarchHome, 'repositories', name);
/** A ship's worktree, in its ship's folder whatever repository it is of. */
/** The ship folder its session starts in. */
const shipFolderOf = (shipId: ShipId): string => join(machine.trierarchHome, 'ships', shipId, 'repositories');

/** The repositories the trierarch reports it offers. */
async function offeredRepositories(): Promise<readonly string[]> {
  const details = z.object({ workspaces: z.object({ repositories: z.array(z.string()) }) }).safeParse((await fleet.reportOfTrierarch())?.details);
  return details.success ? details.data.workspaces.repositories : [];
}

/** Sends the list from the trierarch plugin's ship and waits until the trierarch offers the repository. */
async function aListWaitingOffered(url: string): Promise<void> {
  await fleet.sendToTrierarchAs(plugin, listOf([{ name: TOOLS, url }]));
  await expect.poll(offeredRepositories, { timeout: ANSWERED_WITHIN_MS }).toContain(TOOLS);
}

describe('the trusted repositories', () => {
  it("asks the trierarch plugin's ship for them", async () => {
    // Once per process: adding the repository restarted the service, so the machine's second process asked too.
    await expect.poll(async () => new Set(await fleet.sentByTrierarch(REQUEST_TYPE)), { timeout: ANSWERED_WITHIN_MS }).toEqual(new Set([plugin]));
  });

  it('keeps the list the trierarch plugin sent', async () => {
    const url = anSshRepository();

    await fleet.sendToTrierarchAs(plugin, listOf([{ name: TOOLS, url }]));

    await expect.poll(keptList, { timeout: ANSWERED_WITHIN_MS }).toEqual({ repositories: [{ name: TOOLS, url }] });
  });

  it("trusts each repository's clone in Claude Code before the clone exists", async () => {
    await fleet.sendToTrierarchAs(plugin, listOf([{ name: TOOLS, url: anSshRepository() }]));

    await expect.poll(keptList, { timeout: ANSWERED_WITHIN_MS }).toBeDefined();
    const claude = z.object({ projects: z.record(z.string(), z.object({ hasTrustDialogAccepted: z.boolean() })) }).parse(JSON.parse(readFileSync(join(machine.home, '.claude.json'), 'utf8')));
    expect(claude.projects[cloneOf(TOOLS)]?.hasTrustDialogAccepted).toBe(true);
    expect(existsSync(cloneOf(TOOLS))).toBe(false);
  });

  it('offers a trusted repository beside the configured ones', async () => {
    await aListWaitingOffered(anSshRepository());

    expect([...(await offeredRepositories())].sort()).toEqual([REPOSITORY, TOOLS]);
  });

  it('offers a repository no more once it left the list', async () => {
    await aListWaitingOffered(anSshRepository());

    await fleet.sendToTrierarchAs(plugin, listOf([]));

    await expect.poll(offeredRepositories, { timeout: ANSWERED_WITHIN_MS }).toEqual([REPOSITORY]);
  });

  it('acknowledges a list from another ship and takes none of it', async () => {
    const stranger = await fleet.commission('stranger');

    const messageId = await fleet.sendToTrierarchAs(stranger, listOf([{ name: TOOLS, url: anSshRepository() }]));

    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: ANSWERED_WITHIN_MS }).toBe('acknowledged');
    expect(keptList()).toBeUndefined();
  });

  it('keeps the list it holds when a list does not read', async () => {
    const url = anSshRepository();
    await fleet.sendToTrierarchAs(plugin, listOf([{ name: TOOLS, url }]));
    await expect.poll(keptList, { timeout: ANSWERED_WITHIN_MS }).toBeDefined();

    const messageId = await fleet.sendToTrierarchAs(plugin, listOf([{ name: TOOLS, url: 'https://token@example.test/tools.git' }]));

    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: ANSWERED_WITHIN_MS }).toBe('acknowledged');
    expect(keptSchema.parse(keptList()).repositories).toEqual([{ name: TOOLS, url }]);
  });

  it("clones a repository the machine lacks before the ship's first worktree, and crews in it", async () => {
    await aListWaitingOffered(anSshRepository());
    const scout = await fleet.commission('scout');

    await fleet.crewInRepositories(scout, { main: TOOLS, harness: 'claude-code' });

    await expect.poll(() => existsSync(join(shipFolderOf(scout), 'fake-starts.jsonl')), { timeout: ANSWERED_WITHIN_MS }).toBe(true);
    expect(existsSync(join(cloneOf(TOOLS), 'README.md'))).toBe(true);
    expect(existsSync(`${cloneOf(TOOLS)}.partial`)).toBe(false);
  });

  it('crews in a repository it kept across a restart', async () => {
    await aListWaitingOffered(anSshRepository());
    const restarted = await machine.trierarch(['restart']);
    expect(restarted.status, restarted.stdout + restarted.stderr).toBe(0);
    const scout = await fleet.commission('scout');

    await fleet.crewInRepositories(scout, { main: TOOLS, harness: 'claude-code' });

    await expect.poll(() => existsSync(join(shipFolderOf(scout), 'fake-starts.jsonl')), { timeout: ANSWERED_WITHIN_MS }).toBe(true);
  });

  it('says why a clone failed and leaves no half clone', async () => {
    await aListWaitingOffered('ssh://git@origin.example.test/nowhere/at/all.git');
    const scout = await fleet.commission('scout');

    await fleet.crewInRepositories(scout, { main: TOOLS, harness: 'claude-code' });

    await expect.poll(() => machine.serviceLog(), { timeout: ANSWERED_WITHIN_MS }).toContain('git clone of tools failed');
    expect(existsSync(cloneOf(TOOLS))).toBe(false);
    expect(existsSync(`${cloneOf(TOOLS)}.partial`)).toBe(false);
  });

  it('keeps a configured repository of the same name as the machine configured it', async () => {
    await fleet.sendToTrierarchAs(plugin, listOf([{ name: REPOSITORY, url: 'ssh://git@origin.example.test/nowhere/at/all.git' }]));
    await expect.poll(keptList, { timeout: ANSWERED_WITHIN_MS }).toBeDefined();
    const scout = await fleet.commission('scout');

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => existsSync(join(shipFolderOf(scout), 'fake-starts.jsonl')), { timeout: ANSWERED_WITHIN_MS }).toBe(true);
    expect(existsSync(cloneOf(REPOSITORY))).toBe(false);
    expect(execFileSync('git', ['-C', join(shipFolderOf(scout), 'main'), 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()).toBe(join(realpathSync(machine.repository), '.git'));
  });
});
