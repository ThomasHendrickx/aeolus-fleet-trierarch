import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, listedEntryOf, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// A ship's read-only checkouts (docs/trierarch.md, "Read-only checkouts"): made before its session starts, named to it, refreshed over its socket, and removed with its identity.

const CREWED_WITHIN_MS = 30_000;
const ANSWERED_WITHIN_MS = 30_000;

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (folder: string, ...args: string[]): string => execFileSync('git', ['-C', folder, ...args], { env: { ...process.env, ...IDENTITY }, encoding: 'utf8' }).trim();

let fleet: Fleet;
let machine: Machine;
let scout: ShipId;
/** The repository the working repository names as its checkout. */
let skills: string;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
  await aCrewingMachine({ fleet, machine });
  skills = mkdtempSync(join(tmpdir(), 'trierarch-skills-'));
  execFileSync('git', ['init', '-q', '-b', 'main', skills]);
  writeFileSync(join(skills, 'README.md'), 'skills\n');
  git(skills, 'add', '.');
  git(skills, 'commit', '-q', '-m', 'init');
  const added = await machine.trierarch(['add', 'repository', 'skills', skills]);
  expect(added.status, added.stdout + added.stderr).toBe(0);
  const file = join(machine.trierarchHome, 'config.json');
  const configuration = z.object({ repositories: z.record(z.string(), z.object({ path: z.string() })) }).loose().parse(JSON.parse(readFileSync(file, 'utf8')));
  const working = configuration.repositories[REPOSITORY];
  expect(working).toBeDefined();
  writeFileSync(file, JSON.stringify({ ...configuration, repositories: { ...configuration.repositories, [REPOSITORY]: { ...working, checkouts: ['skills'] } } }));
  const restart = await machine.trierarch(['restart']);
  expect(restart.status, restart.stdout + restart.stderr).toBe(0);
  scout = await fleet.commission('scout', { scopes: ['fleet:read'] });
  await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });
  await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
  await expect.poll(() => sessionOf(machine, 'scout').turns().length, { timeout: CREWED_WITHIN_MS }).toBeGreaterThan(0);
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  // Read-only checkouts a test left are made writable again so the machine can go.
  execFileSync('chmod', ['-R', 'u+w', machine.trierarchHome]);
  await machine.remove();
  await fleet.close();
});

const checkout = (): string => join(machine.trierarchHome, 'checkouts', scout, 'skills');

/** What the identities of the machine's sessions hold, as the aeolus-fleet plugin keeps them. */
function identities(): string {
  const crews = join(machine.home, '.aeolus', 'crews');
  return readdirSync(crews, { recursive: true, encoding: 'utf8' })
    .map((name) => join(crews, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

const answeredSchema = z.object({ path: z.string(), status: z.number(), body: z.string() });

/** What the socket answered scout's session, each call in order. */
function answeredScout(): z.infer<typeof answeredSchema>[] {
  const file = join(sessionOf(machine, 'scout').worktree, 'fake-socket-calls.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => answeredSchema.parse(JSON.parse(line)))
    : [];
}

/** Has scout's session call its ship's socket: what the socket answered. */
async function scoutCalls(method: string, path: string): Promise<z.infer<typeof answeredSchema>> {
  const socket = join(machine.trierarchHome, 'sockets', scout, 'fleet.sock');
  const before = answeredScout().length;
  await fleet.send('scout', `socket call: ${Buffer.from(JSON.stringify({ socket, method, path, body: '{}' })).toString('base64url')}`);
  await expect.poll(() => answeredScout().length, { timeout: ANSWERED_WITHIN_MS }).toBe(before + 1);
  const answered = answeredScout()[before];
  expect(answered).toBeDefined();
  return answeredSchema.parse(answered);
}

describe("a ship's read-only checkouts", () => {
  it('are made at the latest main before its session starts, and read-only', () => {
    expect(readFileSync(join(checkout(), 'README.md'), 'utf8')).toBe('skills\n');
    expect(git(checkout(), 'rev-parse', 'HEAD')).toBe(git(skills, 'rev-parse', 'HEAD'));
    expect(git(checkout(), 'remote')).toBe('');
    expect(() => {
      writeFileSync(join(checkout(), 'README.md'), 'changed\n');
    }).toThrow(/EACCES/);
  });

  it('are read by its Claude Code session beside its folder without asking, and named in its identity, which its start context reads', () => {
    const [start] = sessionOf(machine, 'scout').starts();

    const args = start?.args ?? [];
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual(['--add-dir', checkout()]);
    expect(identities()).toContain(`checkout=skills=${checkout()}`);
  });

  it("are brought to the latest main by a refresh over the ship's socket, which goes nowhere else", async () => {
    writeFileSync(join(skills, 'skill.md'), 'a skill\n');
    git(skills, 'add', '.');
    git(skills, 'commit', '-q', '-m', 'skill');

    const answered = await scoutCalls('POST', '/trierarch/checkouts/refresh');

    expect(answered.status, answered.body).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({ checkouts: [{ repository: 'skills', revision: git(skills, 'rev-parse', 'HEAD') }] });
    expect(readFileSync(join(checkout(), 'skill.md'), 'utf8')).toBe('a skill\n');
  });

  it('go with the ship when its crew request is removed', async () => {
    await fleet.removeCrewRequest(scout);

    await expect.poll(() => existsSync(join(machine.trierarchHome, 'checkouts', scout)), { timeout: CREWED_WITHIN_MS }).toBe(false);
  });
});
