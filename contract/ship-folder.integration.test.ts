import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, describe, expect, it } from 'vitest';

import { aCrewingMachine, isRunning, listedEntryOf, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine, type OtherHarness } from './support/machine.js';

// A ship works in its ship folder, ships/<shipId>/repositories (docs/design/ship-folder.md): its main repository in main/ and each
// sub-repository in sub-repos/<repository>/, each its own worktree; the root AGENTS.md, with CLAUDE.md a link to it, written at every
// start; the session started there, trusted for its harness. A new settings version keeps what it still names, makes what it newly
// names and trashes the rest; every end moves ships/<shipId>/ to the trash, every repository with it, and their worktree records go.

/** A pass runs every 5 seconds, and a crew that fails 3 times in a row is given back. */
const CREWED_WITHIN_MS = 30_000;
const GIVEN_BACK_WITHIN_MS = 60_000;

/** A second configured repository, a ship's sub-repository or another main. */
const TOOLS = 'tools';

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };

const git = (folder: string, ...args: string[]): string => execFileSync('git', ['-C', folder, ...args], { env: { ...process.env, ...IDENTITY }, encoding: 'utf8' }).trim();

let fleet: Fleet;
let machine: Machine;
let scout: ShipId;
/** The tools repository's checkout on the machine. */
let tools: string;

async function aMachineCrewing(at: { others?: OtherHarness[] } = {}): Promise<void> {
  fleet = await aFleet();
  machine = await aMachine(at.others === undefined ? {} : { others: at.others });
  await aCrewingMachine({ fleet, machine });
  tools = join(machine.home, TOOLS);
  execFileSync('git', ['init', '-q', '-b', 'main', tools]);
  writeFileSync(join(tools, 'TOOLS.md'), 'tools\n');
  git(tools, 'add', '.');
  git(tools, 'commit', '-q', '-m', 'init');
  const added = await machine.trierarch(['add', 'repository', TOOLS, tools]);
  expect(added.status, added.stdout + added.stderr).toBe(0);
  scout = await fleet.commission('scout');
}

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

/** The ship's own folder, which holds its ship folder. */
const shipsFolderOf = (shipId: ShipId): string => join(machine.trierarchHome, 'ships', shipId);
/** The ship folder its session starts in. */
const shipFolderOf = (shipId: ShipId): string => join(shipsFolderOf(shipId), 'repositories');

/** The repository a worktree is of: its checkout's git folder. */
const commonGitFolderOf = (worktree: string): string => git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir');

/** The folders git lists as the repository's worktrees, its own checkout first. */
const worktreesOf = (repository: string): string[] =>
  git(repository, 'worktree', 'list', '--porcelain')
    .split('\n')
    .flatMap((line) => (line.startsWith('worktree ') ? [line.slice('worktree '.length)] : []));

async function aRunningScout(at: { subRepositories?: readonly string[]; harness?: string } = {}): Promise<void> {
  await fleet.crewInRepositories(scout, { main: REPOSITORY, subRepositories: at.subRepositories ?? [], harness: at.harness ?? 'claude-code' });
  await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
}

/** The root AGENTS.md of a ship folder whose sub-repositories are those given. */
function rootInstructionsOf(subRepositories: readonly string[]): string {
  const named =
    subRepositories.length === 0
      ? ['None: this ship works in its main repository alone.']
      : subRepositories.map((name) => `- \`sub-repos/${name}/\`: read its AGENTS.md, or its CLAUDE.md where it has none, before working in it.`);
  return [
    '# This ship folder',
    '',
    'This folder holds the repositories this ship works in. Work from `main/`, the main repository: read `main/AGENTS.md` first, or `main/CLAUDE.md` where it has none, and follow it.',
    '',
    '## Sub-repositories',
    '',
    ...named,
    '',
    '## The layout',
    '',
    '- Each repository commits, branches and pushes on its own: run git inside the one you work in.',
    '- This folder holds no repository of its own: nothing outside a repository is committed, so keep your work in one.',
    "- The files and links at this folder's root, this AGENTS.md and CLAUDE.md a link to it, are the trierarch's, written again at every start: change nothing here.",
    '',
  ].join('\n');
}

describe('a ship folder', () => {
  it('is ships/<shipId>/repositories, where the session starts, with main/ and sub-repos/<repository>/ each its own worktree of its repository', async () => {
    await aMachineCrewing();

    await aRunningScout({ subRepositories: [TOOLS] });

    const folder = shipFolderOf(scout);
    expect(sessionOf(machine, 'scout').folder).toBe(folder);
    expect(sessionOf(machine, 'scout').starts()).toHaveLength(1);
    expect(commonGitFolderOf(join(folder, 'main'))).toBe(join(realpathSync(machine.repository), '.git'));
    expect(commonGitFolderOf(join(folder, 'sub-repos', TOOLS))).toBe(join(realpathSync(tools), '.git'));
    expect(git(join(folder, 'sub-repos', TOOLS), 'rev-parse', 'HEAD')).toBe(git(tools, 'rev-parse', 'main'));
    expect(existsSync(join(folder, '.git'))).toBe(false);
  });

  it("has each repository fetched and at origin's default branch, with its origin", async () => {
    await aMachineCrewing();
    const origin = join(machine.machine, 'tools-origin.git');
    execFileSync('git', ['clone', '-q', '--bare', tools, origin]);
    const work = join(machine.machine, 'tools-work');
    execFileSync('git', ['clone', '-q', origin, work]);
    writeFileSync(join(work, 'ahead.txt'), 'ahead\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'ahead');
    git(work, 'push', '-q', 'origin', 'main');
    git(tools, 'remote', 'add', 'origin', origin);

    await aRunningScout({ subRepositories: [TOOLS] });

    const subRepository = join(shipFolderOf(scout), 'sub-repos', TOOLS);
    expect(git(subRepository, 'rev-parse', 'HEAD')).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(git(subRepository, 'remote', 'get-url', 'origin')).toBe(origin);
  });

  it('has the root AGENTS.md naming each sub-repository and the layout, and CLAUDE.md a link to it', async () => {
    await aMachineCrewing();

    await aRunningScout({ subRepositories: [TOOLS] });

    const folder = shipFolderOf(scout);
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toBe(rootInstructionsOf([TOOLS]));
    expect(lstatSync(join(folder, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(folder, 'CLAUDE.md'))).toBe('AGENTS.md');
  });

  it('has its root files written again when its session starts again', async () => {
    await aMachineCrewing();
    await aRunningScout();
    const folder = shipFolderOf(scout);
    const pid = sessionOf(machine, 'scout').starts()[0]?.pid ?? 0;
    writeFileSync(join(folder, 'AGENTS.md'), 'changed by the session\n');
    rmSync(join(folder, 'CLAUDE.md'));

    process.kill(pid, 'SIGKILL');

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(2);
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toBe(rootInstructionsOf([]));
    expect(readlinkSync(join(folder, 'CLAUDE.md'))).toBe('AGENTS.md');
  });

  it('is trusted by Codex before its session starts there', async () => {
    await aMachineCrewing({ others: ['codex'] });

    await aRunningScout({ harness: 'codex' });

    expect(readFileSync(join(machine.home, '.codex', 'config.toml'), 'utf8')).toContain(`[projects.${JSON.stringify(shipFolderOf(scout))}]\ntrust_level = "trusted"`);
  });
});

describe('a crew request naming a sub-repository', () => {
  it('this trierarch does not offer is given back, naming the field', async () => {
    await aMachineCrewing();

    await fleet.crewInRepositories(scout, { main: REPOSITORY, subRepositories: ['missing'], harness: 'claude-code' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain('workspace.subRepositories.0.repository: This trierarch offers no repository missing');
    expect(existsSync(shipsFolderOf(scout))).toBe(false);
  });

  it('git cannot make fails the crew with its message, keeps the main repository made, and the third failure gives the request back', async () => {
    await aMachineCrewing();
    git(tools, 'update-ref', '-d', 'refs/heads/main');

    await fleet.crewInRepositories(scout, { main: REPOSITORY, subRepositories: [TOOLS], harness: 'claude-code' });

    await expect.poll(() => machine.serviceLog(), { timeout: CREWED_WITHIN_MS }).toContain('git worktree add failed: fatal: invalid reference: HEAD');
    expect(existsSync(join(shipFolderOf(scout), 'main', 'README.md'))).toBe(true);
    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain('git worktree add failed: fatal: invalid reference: HEAD');
    expect(sessionOf(machine, 'scout').starts()).toEqual([]);
  });
});

describe('a new settings version', () => {
  it('keeps the repositories it still names, makes the ones it newly names, and trashes the ones it no longer names', async () => {
    await aMachineCrewing();
    await aRunningScout();
    const folder = shipFolderOf(scout);
    writeFileSync(join(folder, 'main', 'kept.txt'), 'kept\n');

    await fleet.requestCrewAgainInRepositories(scout, { main: REPOSITORY, subRepositories: [TOOLS], harness: 'claude-code' });

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(2);
    expect(commonGitFolderOf(join(folder, 'sub-repos', TOOLS))).toBe(join(realpathSync(tools), '.git'));
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toBe(rootInstructionsOf([TOOLS]));

    await fleet.requestCrewAgainInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(3);
    expect(existsSync(join(folder, 'sub-repos', TOOLS))).toBe(false);
    expect(readFileSync(join(folder, 'main', 'kept.txt'), 'utf8')).toBe('kept\n');
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toBe(rootInstructionsOf([]));
  });

  it('naming another main repository replaces main/', async () => {
    await aMachineCrewing();
    await aRunningScout();

    await fleet.requestCrewAgainInRepositories(scout, { main: TOOLS, harness: 'claude-code' });

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(2);
    expect(commonGitFolderOf(join(shipFolderOf(scout), 'main'))).toBe(join(realpathSync(tools), '.git'));
  });
});

describe("a ship folder's end", () => {
  it("moves ships/<shipId>/ to the trash with every repository in it, and their worktree records go", async () => {
    await aMachineCrewing();
    await aRunningScout({ subRepositories: [TOOLS] });
    const pid = sessionOf(machine, 'scout').starts()[0]?.pid ?? 0;

    await fleet.removeCrewRequest(scout);

    await expect.poll(() => existsSync(shipsFolderOf(scout)), { timeout: CREWED_WITHIN_MS }).toBe(false);
    expect(isRunning(pid)).toBe(false);
    await expect.poll(() => [worktreesOf(machine.repository), worktreesOf(tools)], { timeout: CREWED_WITHIN_MS }).toEqual([[realpathSync(machine.repository)], [realpathSync(tools)]]);
  });
});
