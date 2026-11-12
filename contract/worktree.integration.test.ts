import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, isRunning, sessionOf, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// A ship's worktree is made from the ref the workspace names as origin has it, never from a clone's local branch, and a worktree that cannot be made says why (docs/trierarch.md, "Workspaces").
// Every folder under the root no crewed ship uses goes, whatever it is or holds, once what runs in it is stopped (gap rule 2).
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

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    expect(git(sessionOf(machine, 'scout').main, 'rev-parse', 'HEAD')).toBe(ahead);
  });

  it("is crewed when the clone has no local main, starting on origin's main", async () => {
    const ahead = anOriginAhead();
    git(machine.repository, 'fetch', '-q', 'origin');
    git(machine.repository, 'update-ref', '-d', 'refs/heads/main');

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    expect(git(sessionOf(machine, 'scout').main, 'rev-parse', 'HEAD')).toBe(ahead);
  });

  it("says git's message when no worktree can be made", async () => {
    git(machine.repository, 'update-ref', '-d', 'refs/heads/main');

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => machine.serviceLog(), { timeout: CREWED_WITHIN_MS }).toContain('git worktree add failed: fatal: invalid reference: HEAD');
  });

  it("gives the request back with git's message when no worktree can be made", async () => {
    git(machine.repository, 'update-ref', '-d', 'refs/heads/main');

    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain('git worktree add failed: fatal: invalid reference: HEAD');
    expect((await fleet.givenBackReasonOf(scout))?.length).toBeLessThanOrEqual(200);
  });
});

/**
 * A folder under the trierarch's root, `ships/` unless another is given, that no
 * ship works in, at its path below the root, with a process already running in it, as a dev server a retired
 * ship's session left: its folder and the process's pid. Made what it is after
 * the process started, so no pass finds it with nothing running in it.
 */
function aStrayWithAProcess(at: { path: readonly string[]; make: (folder: string) => void; root?: string }): { folder: string; pid: number } {
  const folder = join(at.root ?? join(machine.trierarchHome, 'ships'), ...at.path);
  mkdirSync(folder, { recursive: true });
  const child = spawn('sleep', ['600'], { cwd: folder, detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid ?? 0;
  started.push(pid);
  at.make(folder);
  return { folder, pid };
}

const aWorktreeOfTheRepository = (folder: string): void => {
  git(machine.repository, 'worktree', 'add', '-q', '--detach', folder);
};
const aPlainClone = (folder: string): void => {
  execFileSync('git', ['clone', '-q', machine.repository, folder]);
};
const aFileGitDoesNotKnow = (folder: string): void => {
  writeFileSync(join(folder, 'notes.md'), 'no repository\n');
};

describe('a folder under the root no crewed ship uses', () => {
  it('is removed whatever it is or holds, once what runs in it is stopped, and is no orphan', async () => {
    const strays = [
      aStrayWithAProcess({ path: [REPOSITORY, 'orphan'], make: aWorktreeOfTheRepository }),
      aStrayWithAProcess({
        path: [REPOSITORY, 'unsaved'],
        make: (folder) => {
          aWorktreeOfTheRepository(folder);
          writeFileSync(join(folder, 'unsaved.txt'), 'unsaved\n');
        },
      }),
      aStrayWithAProcess({ path: [REPOSITORY, 'own-clone'], make: aPlainClone }),
      aStrayWithAProcess({ path: [REPOSITORY, 'notes'], make: aFileGitDoesNotKnow }),
      // Straight under the root: a plain clone, and a folder git does not know.
      aStrayWithAProcess({ path: ['designer-release'], make: aPlainClone }),
      aStrayWithAProcess({ path: ['workbench'], make: aFileGitDoesNotKnow }),
    ];

    for (const { folder } of strays) {
      // Said once the folder is removed.
      await expect.poll(() => machine.serviceLog(), { timeout: CLEARED_WITHIN_MS }).toContain(`Removed ${folder}, a folder under the root no crewed ship uses, after stopping 1 process in it`);
    }
    expect(strays.filter(({ folder }) => existsSync(folder))).toEqual([]);
    expect(strays.filter(({ pid }) => isRunning(pid))).toEqual([]);
    const status = await machine.trierarch(['status', '--json']);
    expect(JSON.parse(status.stdout)).toMatchObject({ kept: [], orphans: [] });
  });

  it('that is no repository the trierarch has goes whole, with a clone of another repository in it and what runs there', async () => {
    const unrelated = join(machine.trierarchHome, 'ships', 'hemma');
    const { pid } = aStrayWithAProcess({ path: ['hemma', 'scout'], make: aPlainClone });

    await expect.poll(() => machine.serviceLog(), { timeout: CLEARED_WITHIN_MS }).toContain(`Removed ${unrelated}, a folder under the root no crewed ship uses, after stopping 1 process in it`);
    expect(existsSync(unrelated)).toBe(false);
    expect(isRunning(pid)).toBe(false);
  });

  it('that holds the folder a ship is crewed in stays, and so does the trash', async () => {
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    const { folder: worktree } = sessionOf(machine, 'scout');
    const trash = join(machine.trierarchHome, 'ships', '.trash');
    mkdirSync(trash, { recursive: true });
    const { folder } = aStrayWithAProcess({ path: [REPOSITORY, 'lookout'], make: aFileGitDoesNotKnow });

    await expect.poll(() => machine.serviceLog(), { timeout: CLEARED_WITHIN_MS }).toContain(`Removed ${folder}, a folder under the root no crewed ship uses`);
    expect([existsSync(worktree), existsSync(socketOf(scout)), existsSync(trash)]).toEqual([true, true, true]);
  });

  it("that is the folder of a ship no longer crewed here goes whole, its worktree and all it holds", async () => {
    const gone = 'shp_01m000000000000000000gone0';
    const { pid } = aStrayWithAProcess({
      path: [gone, 'worktree'],
      make: (folder) => {
        aWorktreeOfTheRepository(folder);
        mkdirSync(join(shipFolderOf(gone), 'sockets'));
      },
    });

    await expect.poll(() => machine.serviceLog(), { timeout: CLEARED_WITHIN_MS }).toContain(`Removed ${shipFolderOf(gone)}, a folder under the root no crewed ship uses, after stopping 1 process in it`);
    expect(existsSync(shipFolderOf(gone))).toBe(false);
    expect(isRunning(pid)).toBe(false);
  });

  it('under the worktree root of the ships crewed before the ship folders, ~/.aeolus/trierarch/worktrees, goes too', async () => {
    const before = join(machine.trierarchHome, 'worktrees');
    const { folder, pid } = aStrayWithAProcess({ root: before, path: [REPOSITORY, 'orphan'], make: aWorktreeOfTheRepository });

    await expect.poll(() => machine.serviceLog(), { timeout: CLEARED_WITHIN_MS }).toContain(`Removed ${folder}, a folder under the root no crewed ship uses, after stopping 1 process in it`);
    expect(existsSync(folder)).toBe(false);
    expect(isRunning(pid)).toBe(false);
  });
});

/** A ship's own folder, which holds every file of the ship, and no secret. */
const shipFolderOf = (shipId: string): string => join(machine.trierarchHome, 'ships', shipId);
/** A ship's fleet socket, in its ship's folder. */
const socketOf = (shipId: string): string => join(shipFolderOf(shipId), 'sockets', 'fleet.sock');

/** Every file under the folder, by its path; a socket or a link is no file. */
function filesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .map((name) => join(folder, name))
    .filter((path) => lstatSync(path).isFile());
}

const savedSchema = z.object({ entries: z.record(z.string(), z.object({ crewToken: z.string().optional() }).loose()) });

describe("a ship's folder", () => {
  it('is made when a ship is crewed fresh, ships/<shipId>/, holding its ship folder and its fleet socket, which its identity names', async () => {
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    expect(sessionOf(machine, 'scout').folder).toBe(join(shipFolderOf(scout), 'repositories'));
    expect(lstatSync(socketOf(scout)).isSocket()).toBe(true);
    const identities = filesUnder(join(machine.home, '.aeolus', 'crews', 'claude-code')).map((path) => readFileSync(path, 'utf8'));
    expect(identities.filter((identity) => identity.includes(`socket=${socketOf(scout)}\n`))).toHaveLength(1);
  });

  it("holds no token: the ship's crew token and the trierarch's stay in the trierarch's own files beside ships/, and the hold's files too", async () => {
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    const crewToken = savedSchema.parse(JSON.parse(readFileSync(join(machine.trierarchHome, 'state.json'), 'utf8'))).entries[scout]?.crewToken ?? '';
    const tokens = [crewToken, readFileSync(join(machine.trierarchHome, 'crew-token'), 'utf8').trim()];
    expect(tokens.filter((token) => token.length < 20)).toEqual([]);

    const holding = filesUnder(join(machine.trierarchHome, 'ships')).filter((path) => tokens.some((token) => readFileSync(path, 'utf8').includes(token)));

    expect(holding).toEqual([]);
    expect(existsSync(join(machine.trierarchHome, 'sessions', scout, 'hold.pid'))).toBe(true);
  });

  it('goes whole when its crew request is removed, once its session stopped', async () => {
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    const pid = sessionOf(machine, 'scout').starts()[0]?.pid ?? 0;

    await fleet.removeCrewRequest(scout);

    await expect.poll(() => existsSync(shipFolderOf(scout)), { timeout: CLEARED_WITHIN_MS }).toBe(false);
    expect(isRunning(pid)).toBe(false);
  });
});

describe('ships/ removed by hand', () => {
  it('has every ship crewed here crewed again in a fresh ship folder, as a first start', async () => {
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    const pid = sessionOf(machine, 'scout').starts()[0]?.pid ?? 0;

    rmSync(join(machine.trierarchHome, 'ships'), { recursive: true, force: true });

    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CLEARED_WITHIN_MS }).toBe(1);
    expect(sessionOf(machine, 'scout').folder).toBe(join(shipFolderOf(scout), 'repositories'));
    expect(sessionOf(machine, 'scout').starts()[0]?.pid).not.toBe(pid);
    expect(isRunning(pid)).toBe(false);
    expect(lstatSync(socketOf(scout)).isSocket()).toBe(true);
    await expect(fleet.toldByTrierarch()).resolves.toEqual([]);
  });
});

describe('a place of ships/ where a socket path would pass the system limit', () => {
  /** A place for ships/ long enough that a ship's socket path in it is over 108 bytes, Linux's limit. */
  const aLongPlace = (): string => join(machine.trierarchHome, 'a-place-of-ships-far-too-long-for-a-socket-path-on-any-system-at-all');

  function configureShipsAt(place: string): void {
    const file = join(machine.trierarchHome, 'config.json');
    writeFileSync(file, JSON.stringify({ ...z.looseObject({}).parse(JSON.parse(readFileSync(file, 'utf8'))), shipsRoot: place }));
  }

  const refusalOf = (place: string): string => {
    const socket = join(place, 'shp_00000000000000000000000000', 'sockets', 'fleet.sock');
    return `The configuration at ${join(machine.trierarchHome, 'config.json')} keeps the ships' files in ${place}, where a ship's socket path, as ${socket}, is ${String(Buffer.byteLength(socket))} bytes, past the system's limit of 108: name a shorter place in shipsRoot`;
  };

  it('is what config check refuses, naming the setting to shorten', async () => {
    configureShipsAt(aLongPlace());

    const ran = await machine.trierarch(['config', 'check']);

    expect(ran.status).not.toBe(0);
    expect(ran.stdout + ran.stderr).toContain(refusalOf(aLongPlace()));
  });

  it('is what run refuses too', async () => {
    configureShipsAt(aLongPlace());

    const ran = await machine.trierarch(['run']);

    expect(ran.status).not.toBe(0);
    expect(ran.stdout + ran.stderr).toContain(refusalOf(aLongPlace()));
  });
});

describe('a configuration that still names worktreeRoot', () => {
  const refusal = (): string => `The configuration at ${join(machine.trierarchHome, 'config.json')} names worktreeRoot, which is now shipsRoot: rename the line to shipsRoot`;

  function configureWorktreeRoot(): void {
    const file = join(machine.trierarchHome, 'config.json');
    writeFileSync(file, JSON.stringify({ ...z.looseObject({}).parse(JSON.parse(readFileSync(file, 'utf8'))), worktreeRoot: join(machine.trierarchHome, 'worktrees') }));
  }

  for (const words of [['config', 'check'], ['run']]) {
    it(`is refused by ${words.join(' ')}, naming the line and its new name`, async () => {
      configureWorktreeRoot();

      const ran = await machine.trierarch(words);

      expect(ran.status).not.toBe(0);
      expect(ran.stdout + ran.stderr).toContain(refusal());
    });
  }
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
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
    await expect.poll(() => sessionOf(machine, 'scout').starts().length, { timeout: CREWED_WITHIN_MS }).toBe(1);
    const { main } = sessionOf(machine, 'scout');
    writeFileSync(join(main, 'unsaved.txt'), 'unsaved\n');
    claudeTrustsNothing();

    await fleet.requestCrewAgainInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => existsSync(main), { timeout: GIVEN_BACK_WITHIN_MS }).toBe(false);
    await expect.poll(() => machine.serviceLog(), { timeout: GIVEN_BACK_WITHIN_MS }).toContain(`Discarded from the worktree of scout (${scout}), ${main}: ?? unsaved.txt`);
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
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
    await fleet.requestWorktreeClear(scout, REPOSITORY);

    await expect.poll(() => fleet.clearedOutcomeOf(scout, REPOSITORY), { timeout: CLEARED_WITHIN_MS }).toBe('not-kept');
    expect(await fleet.givenBackReasonOf(scout)).toBeUndefined();
  });
});
