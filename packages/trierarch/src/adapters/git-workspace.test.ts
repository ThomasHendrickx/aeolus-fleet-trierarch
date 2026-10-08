import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { createGitWorkspace } from './git-workspace.js';
import { runCommand } from './run-command.js';

// Against the real git, in a temporary folder.

let folder: string;
let repository: string;
let root: string;
let notes: string;

async function git(args: string[]): Promise<string> {
  const result = await runCommand('git', { args, env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' } });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function workspace() {
  return createGitWorkspace({
    configuration: { ...CONFIGURATION, repositories: { 'aeolus-fleet': { path: repository } }, folders: { notes: { path: notes } } },
    root,
  });
}

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-git-'));
  repository = join(folder, 'aeolus-fleet');
  root = join(folder, 'worktrees');
  notes = join(folder, 'notes');
  mkdirSync(notes);
  await git(['init', '-q', '-b', 'main', repository]);
  writeFileSync(join(repository, 'README.md'), 'hello\n');
  await git(['-C', repository, 'add', '.']);
  await git(['-C', repository, 'commit', '-q', '-m', 'init']);
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const scout = { shipId: newId('ship'), shipName: 'scout', workspace: { kind: 'worktree', repository: 'aeolus-fleet' } } as const;

describe('workspaces in git', () => {
  it('makes a worktree of the repository under the root, one folder per ship, detached at HEAD', async () => {
    const { folder: made } = await workspace().prepare(scout);

    expect(made).toBe(join(root, 'aeolus-fleet', 'scout'));
    expect(existsSync(join(made, 'README.md'))).toBe(true);
    expect((await git(['-C', made, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('HEAD');
  });

  it("checks out the settings' ref", async () => {
    await git(['-C', repository, 'tag', 'v1']);
    writeFileSync(join(repository, 'later.md'), 'later\n');
    await git(['-C', repository, 'add', '.']);
    await git(['-C', repository, 'commit', '-q', '-m', 'later']);

    const { folder: made } = await workspace().prepare({ ...scout, workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'v1' } });

    expect(existsSync(join(made, 'later.md'))).toBe(false);
  });

  it("fetches the repository first and checks out the remote branch for a ref, so a ship starts from current code and not from a stale local branch", async () => {
    const upstream = join(folder, 'upstream');
    await git(['clone', '-q', repository, upstream]);
    await git(['-C', repository, 'remote', 'add', 'origin', upstream]);
    await git(['-C', repository, 'fetch', '-q', 'origin']);
    writeFileSync(join(upstream, 'current.md'), 'current\n');
    await git(['-C', upstream, 'add', '.']);
    await git(['-C', upstream, 'commit', '-q', '-m', 'current']);

    const { folder: made } = await workspace().prepare({ ...scout, workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'main' } });

    expect(existsSync(join(made, 'current.md'))).toBe(true);
    expect((await git(['-C', made, 'rev-parse', 'HEAD'])).trim()).toBe((await git(['-C', upstream, 'rev-parse', 'HEAD'])).trim());
  });

  it('checks out a ref the remote has no branch for as it is, and crews a repository with no remote', async () => {
    await git(['-C', repository, 'tag', 'v1']);

    const { folder: made } = await workspace().prepare({ ...scout, workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'v1' } });

    expect((await git(['-C', made, 'rev-parse', 'HEAD'])).trim()).toBe((await git(['-C', repository, 'rev-parse', 'v1'])).trim());
  });

  it('crews from what it has when the remote cannot be fetched', async () => {
    await git(['-C', repository, 'remote', 'add', 'origin', join(folder, 'gone')]);

    const { folder: made } = await workspace().prepare({ ...scout, workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'main' } });

    expect(existsSync(join(made, 'README.md'))).toBe(true);
  });

  it('uses a worktree a stop mid-crew left', async () => {
    const first = await workspace().prepare(scout);

    await expect(workspace().prepare(scout)).resolves.toEqual(first);
  });

  it('says a fresh worktree is clean, and one with a change or a new file is not', async () => {
    const { folder: made } = await workspace().prepare(scout);
    expect(await workspace().isClean(made)).toBe(true);

    writeFileSync(join(made, 'notes.md'), 'draft\n');

    expect(await workspace().isClean(made)).toBe(false);
  });

  it('removes a worktree it made', async () => {
    const { folder: made } = await workspace().prepare(scout);

    await workspace().remove(made);

    expect(existsSync(made)).toBe(false);
    expect(await git(['-C', repository, 'worktree', 'list'])).not.toContain('scout');
  });

  it('refuses to remove anything outside its root', async () => {
    await expect(workspace().remove(notes)).rejects.toThrow('removes only what it made');
    expect(existsSync(notes)).toBe(true);
  });

  it('uses a configured folder as it is', async () => {
    await expect(workspace().prepare({ ...scout, workspace: { kind: 'folder', name: 'notes' } })).resolves.toEqual({ folder: notes });
  });

  it('lists the worktrees under its root, each with its repository and name', async () => {
    await workspace().prepare(scout);
    await workspace().prepare({ ...scout, shipId: newId('ship'), shipName: 'lookout' });

    expect([...(await workspace().worktrees())].sort((first, second) => first.path.localeCompare(second.path))).toEqual([
      { path: join(root, 'aeolus-fleet', 'lookout'), repository: 'aeolus-fleet', name: 'lookout' },
      { path: join(root, 'aeolus-fleet', 'scout'), repository: 'aeolus-fleet', name: 'scout' },
    ]);
  });
});
