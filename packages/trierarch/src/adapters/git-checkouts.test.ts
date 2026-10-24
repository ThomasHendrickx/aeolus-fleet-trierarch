import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { createGitCheckouts } from './git-checkouts.js';
import { runCommand } from './run-command.js';

// Against the real git, in a temporary folder. Read-only is the file system's: the tests run as a user other than root.

const AUTHOR = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };

let folder: string;
let root: string;
let company: string;
let governance: string;
let skills: string;
let upstream: string;

async function git(args: string[]): Promise<string> {
  const result = await runCommand('git', { args, env: AUTHOR });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function commit(repository: string, file: string): Promise<string> {
  writeFileSync(join(repository, file), `${file}\n`);
  await git(['-C', repository, 'add', '.']);
  await git(['-C', repository, 'commit', '-q', '-m', file]);
  return git(['-C', repository, 'rev-parse', 'HEAD']);
}

async function aRepository(name: string): Promise<string> {
  const repository = join(folder, name);
  await git(['init', '-q', '-b', 'main', repository]);
  await commit(repository, 'README.md');
  return repository;
}

function checkouts() {
  return createGitCheckouts({
    configuration: {
      ...CONFIGURATION,
      repositories: { 'aeolus-company': { path: company, checkouts: ['governance', 'skills'] }, governance: { path: governance }, skills: { path: skills } },
    },
    root,
  });
}

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-checkouts-'));
  root = join(folder, 'checkouts');
  company = await aRepository('aeolus-company');
  governance = await aRepository('governance');
  skills = await aRepository('skills');
  // The governance repository's checkout on the machine has a remote, whose main moves on.
  upstream = join(folder, 'governance-upstream');
  await git(['clone', '-q', governance, upstream]);
  await git(['-C', governance, 'remote', 'add', 'origin', upstream]);
  await git(['-C', governance, 'fetch', '-q', 'origin']);
});

afterEach(async () => {
  // Read-only checkouts a test left are made writable again so they can go.
  await runCommand('chmod', { args: ['-R', 'u+w', folder] });
  rmSync(folder, { recursive: true, force: true });
});

const scout = newId('ship');

describe('read-only checkouts in git (#1182)', () => {
  it('makes a checkout of each repository the working repository names, per ship', async () => {
    const made = await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });

    expect(made).toEqual([
      { repository: 'governance', path: join(root, scout, 'governance') },
      { repository: 'skills', path: join(root, scout, 'skills') },
    ]);
    expect(existsSync(join(root, scout, 'skills', 'README.md'))).toBe(true);
  });

  it('makes none for a repository that names none', async () => {
    await expect(checkouts().prepare({ shipId: scout, repository: 'skills' })).resolves.toEqual([]);
  });

  it('checks out the latest main of the remote, fetched first, so a session starts from current rules', async () => {
    const latest = await commit(upstream, 'rule.md');

    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });

    expect(await git(['-C', join(root, scout, 'governance'), 'rev-parse', 'HEAD'])).toBe(latest);
  });

  it("checks out the repository's own main when it has no remote", async () => {
    const latest = await commit(skills, 'skill.md');

    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });

    expect(await git(['-C', join(root, scout, 'skills'), 'rev-parse', 'HEAD'])).toBe(latest);
  });

  it('keeps a checkout the ship has already', async () => {
    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });
    const before = await git(['-C', join(root, scout, 'governance'), 'rev-parse', 'HEAD']);
    await commit(upstream, 'rule.md');

    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });

    expect(await git(['-C', join(root, scout, 'governance'), 'rev-parse', 'HEAD'])).toBe(before);
  });

  it('lets the session change no file in a checkout', async () => {
    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });

    expect(() => {
      writeFileSync(join(root, scout, 'governance', 'README.md'), 'changed\n');
    }).toThrow(/EACCES/);
    expect(() => {
      writeFileSync(join(root, scout, 'governance', 'new.md'), 'new\n');
    }).toThrow(/EACCES/);
  });

  it('lets the session commit nothing in a checkout', async () => {
    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });

    const committed = await runCommand('git', { args: ['-C', join(root, scout, 'governance'), 'commit', '-q', '--allow-empty', '-m', 'mine'], env: AUTHOR });

    expect(committed.status).not.toBe(0);
  });

  it('gives a checkout no remote to push to', async () => {
    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });

    expect(await git(['-C', join(root, scout, 'governance'), 'remote'])).toBe('');
  });

  it('refreshes each checkout to the latest main, answering the revision it now holds', async () => {
    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });
    const governanceLatest = await commit(upstream, 'rule.md');
    const skillsLatest = await commit(skills, 'skill.md');

    const refreshed = await checkouts().refresh(scout);

    expect(refreshed).toEqual([
      { repository: 'governance', revision: governanceLatest },
      { repository: 'skills', revision: skillsLatest },
    ]);
    expect(existsSync(join(root, scout, 'governance', 'rule.md'))).toBe(true);
  });

  it('keeps a refreshed checkout read-only', async () => {
    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });
    await commit(upstream, 'rule.md');

    await checkouts().refresh(scout);

    expect(() => {
      writeFileSync(join(root, scout, 'governance', 'rule.md'), 'changed\n');
    }).toThrow(/EACCES/);
  });

  it('answers why a checkout could not be refreshed, and refreshes the others', async () => {
    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });
    rmSync(governance, { recursive: true, force: true });
    const skillsLatest = await commit(skills, 'skill.md');

    const refreshed = await checkouts().refresh(scout);

    const [first] = refreshed;
    expect(first?.repository).toBe('governance');
    expect(first !== undefined && 'problem' in first ? first.problem : undefined).toContain('governance');
    expect(refreshed[1]).toEqual({ repository: 'skills', revision: skillsLatest });
  });

  it('answers no checkouts for a ship that has none', async () => {
    await expect(checkouts().refresh(scout)).resolves.toEqual([]);
  });

  it("removes the ship's checkouts, read-only as they are", async () => {
    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });

    await checkouts().remove(scout);

    expect(existsSync(join(root, scout))).toBe(false);
  });

  it('removes nothing of another ship', async () => {
    const lookout = newId('ship');
    await checkouts().prepare({ shipId: scout, repository: 'aeolus-company' });
    await checkouts().prepare({ shipId: lookout, repository: 'aeolus-company' });

    await checkouts().remove(scout);

    expect(existsSync(join(root, lookout, 'governance', 'README.md'))).toBe(true);
  });
});
