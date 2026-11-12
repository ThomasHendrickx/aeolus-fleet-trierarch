import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, isRunning, sessionOf, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// A ship's worktree is made from the ref the workspace names as origin has it, never from a clone's local branch, and a worktree that cannot be made says why (docs/trierarch.md, "Workspaces").
// A worktree under the root that no ship works in is an orphan: what runs in it is stopped, then it is removed, unless it holds unsaved work (#1041).
// A crew given back removes its worktree whatever it holds, as every path does, so no worktree is kept: a clear request is confirmed not-kept (decision 0032).

/** A pass runs every 5 seconds, and a crew that fails 3 times in a row is given back. */
const CREWED_WITHIN_MS = 30_000;
const GIVEN_BACK_WITHIN_MS = 60_000;
/** A pass every 5 seconds, and a process that does not end is killed 5 seconds after it was asked to. */
const CLEARED_WITHIN_MS = 30_000;

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };

const git = (folder: string, ...args: string[]): string => execFileSync('git', ['-C', folder, ...args], { env: { ...process.env, ...IDENTITY }, encoding: 'utf8' }).trim();

let fleet: Fleet;
let machine: Machine;
let scout: ShipId;
/** The processes a test started, each stopped after it by its pid. */
let started: number[] = [];

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
  for (const pid of started.filter(isRunning)) {
    process.kill(pid, 'SIGKILL');
  }
  started = [];
  await machine.remove();
  await fleet.close();
});

/** Gives the machine's clone an origin one commit ahead of its main, and answers that commit. */
function anOriginAhead(): string {
  const origin = mkdtempSync(join(tmpdir(), 'trierarch-origin-'));
  execFileSync('git', ['clone', '-q', '--bare', machine.repository, origin]);
  const work = mkdtempSync(join(tmpdir(), 'trierarch-work-'));
  execFileSync('git', ['clone', '-q', origin, work]);
  writeFileSync(join(work, 'ahead.txt'), 'ahead\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'ahead');
  git(work, 'push', '-q', 'origin', 'main');
  git(machine.repository, 'remote', 'add', 'origin', origin);
  return git(work, 'rev-parse', 'HEAD');
}

describe('a ship in a worktree of a repository', () => {
  it("starts on origin's main when the clone's main is behind", async () => {
    const ahead = anOriginAhead();

    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    expect(git(sessionOf(machine, 'scout').worktree, 'rev-parse', 'HEAD')).toBe(ahead);
  });

  it("is crewed when the clone has no local main, starting on origin's main", async () => {
    const ahead = anOriginAhead();
    git(machine.repository, 'fetch', '-q', 'origin');
    git(machine.repository, 'update-ref', '-d', 'refs/heads/main');

    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    expect(git(sessionOf(machine, 'scout').worktree, 'rev-parse', 'HEAD')).toBe(ahead);
  });

  it("says git's message when no worktree can be made", async () => {
    git(machine.repository, 'update-ref', '-d', 'refs/heads/main');

    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => machine.serviceLog(), { timeout: CREWED_WITHIN_MS }).toContain('git worktree add failed: fatal: invalid reference: HEAD');
  });

  it("gives the request back with git's message when no worktree can be made", async () => {
    git(machine.repository, 'update-ref', '-d', 'refs/heads/main');

    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain('git worktree add failed: fatal: invalid reference: HEAD');
    expect((await fleet.givenBackReasonOf(scout))?.length).toBeLessThanOrEqual(200);
  });
});

/** A worktree of the machine's repository under the trierarch's root that no ship works in, with a process already running in it, as a dev server a retired ship's session left: its folder and the process's pid. */
function anOrphanWithAProcess(name: string): { folder: string; pid: number } {
  const folder = join(machine.trierarchHome, 'worktrees', REPOSITORY, name);
  mkdirSync(folder, { recursive: true });
  // Started before the folder is a worktree, so no pass finds the orphan with nothing running in it.
  const child = spawn('sleep', ['600'], { cwd: folder, detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid ?? 0;
  started.push(pid);
  git(machine.repository, 'worktree', 'add', '-q', '--detach', folder);
  return { folder, pid };
}

describe('an orphan worktree', () => {
  it('is removed once what runs in it is stopped', async () => {
    const { folder, pid } = anOrphanWithAProcess('stray');

    // Said once the worktree is removed and the state saved.
    await expect.poll(() => machine.serviceLog(), { timeout: CLEARED_WITHIN_MS }).toContain(`Removed the orphan worktree ${folder}, after stopping 1 process in it`);
    expect(existsSync(folder)).toBe(false);
    expect(isRunning(pid)).toBe(false);
  });

  it('that holds unsaved work stays, with what runs in it stopped, and status names it', async () => {
    const { folder, pid } = anOrphanWithAProcess('stray');
    writeFileSync(join(folder, 'unsaved.txt'), 'unsaved\n');

    await expect.poll(() => isRunning(pid), { timeout: CLEARED_WITHIN_MS }).toBe(false);
    await expect.poll(() => machine.serviceLog(), { timeout: CLEARED_WITHIN_MS }).toContain(`Kept the orphan worktree ${folder}, which holds unsaved work: ?? unsaved.txt`);
    expect(existsSync(folder)).toBe(true);
    const status = await machine.trierarch(['status', '--json']);
    expect(JSON.parse(status.stdout)).toMatchObject({ orphans: [folder] });
  });
});

/** Rewrites Claude Code's .claude.json so it trusts no folder: a new settings version of a ship in the repository is given back. */
function claudeTrustsNothing(): void {
  const file = join(machine.home, '.claude.json');
  const claude = z.looseObject({}).parse(JSON.parse(readFileSync(file, 'utf8')));
  writeFileSync(file, JSON.stringify({ ...claude, projects: {} }));
}

const statusSchema = z.object({ kept: z.array(z.object({ path: z.string() })) });

async function keptPaths(): Promise<readonly string[]> {
  const status = await machine.trierarch(['status', '--json']);
  return statusSchema.parse(JSON.parse(status.stdout)).kept.map(({ path }) => path);
}

describe('a crew given back before it is final', () => {
  it('removes its worktree with changes too and keeps none', async () => {
    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });
    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    const { worktree } = sessionOf(machine, 'scout');
    writeFileSync(join(worktree, 'unsaved.txt'), 'unsaved\n');
    claudeTrustsNothing();

    await fleet.requestCrewAgainInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => existsSync(worktree), { timeout: GIVEN_BACK_WITHIN_MS }).toBe(false);
    expect(machine.serviceLog()).toContain(`Discarded from the worktree of scout (${scout}), ${worktree}: `);
    expect(await keptPaths()).toEqual([]);
  });
});

describe('a clear request for a worktree the trierarch keeps none of', () => {
  it('is confirmed not-kept', async () => {
    await fleet.requestWorktreeClear(scout, REPOSITORY);

    await expect.poll(() => fleet.clearedOutcomeOf(scout, REPOSITORY), { timeout: CLEARED_WITHIN_MS }).toBe('not-kept');
  });
});

describe('a clear request for a ship whose crew fails in the same pass', () => {
  it('is carried out in that pass, before the crew is given back', async () => {
    git(machine.repository, 'update-ref', '-d', 'refs/heads/main');
    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });
    await fleet.requestWorktreeClear(scout, REPOSITORY);

    await expect.poll(() => fleet.clearedOutcomeOf(scout, REPOSITORY), { timeout: CLEARED_WITHIN_MS }).toBe('not-kept');
    expect(await fleet.givenBackReasonOf(scout)).toBeUndefined();
  });
});
