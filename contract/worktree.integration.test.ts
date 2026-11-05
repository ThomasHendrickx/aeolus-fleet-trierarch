import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aCrewingMachine, sessionOf, REPOSITORY } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';
import { isTodaysTrierarch } from './support/trierarch-under-test.js';

// A ship's worktree is made from the ref the workspace names as origin has it, never from a clone's local branch, and a worktree that cannot be made says why (docs/trierarch.md, "Workspaces").

/** A pass runs every 5 seconds, and a crew that fails 3 times in a row is given back. */
const CREWED_WITHIN_MS = 30_000;
const GIVEN_BACK_WITHIN_MS = 60_000;

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };

const git = (folder: string, ...args: string[]): string => execFileSync('git', ['-C', folder, ...args], { env: { ...process.env, ...IDENTITY }, encoding: 'utf8' }).trim();

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

  // The Go trierarch gives no crew back yet (#169): its give-back is held here once it does.
  it.runIf(isTodaysTrierarch)("gives the request back with git's message when no worktree can be made", async () => {
    git(machine.repository, 'update-ref', '-d', 'refs/heads/main');

    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => fleet.givenBackReasonOf(scout), { timeout: GIVEN_BACK_WITHIN_MS }).toContain('git worktree add failed: fatal: invalid reference: HEAD');
    expect((await fleet.givenBackReasonOf(scout))?.length).toBeLessThanOrEqual(200);
  });
});
