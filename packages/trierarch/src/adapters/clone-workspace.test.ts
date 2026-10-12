import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { createCloneWorkspace } from './clone-workspace.js';
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

async function commit(at: string, file: string): Promise<void> {
  writeFileSync(join(at, file), `${file}\n`);
  await git(['-C', at, 'add', '.']);
  await git(['-C', at, 'commit', '-q', '-m', file]);
}

/** An upstream the repository has as its origin, fetched. */
async function withUpstream(): Promise<string> {
  const upstream = join(folder, 'upstream');
  await git(['clone', '-q', '--bare', repository, upstream]);
  await git(['-C', repository, 'remote', 'add', 'origin', upstream]);
  await git(['-C', repository, 'fetch', '-q', 'origin']);
  return upstream;
}

function workspace() {
  return createCloneWorkspace({
    configuration: { ...CONFIGURATION, repositories: { 'aeolus-fleet': { path: repository } }, folders: { notes: { path: notes } } },
    root,
  });
}

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-clone-'));
  repository = join(folder, 'aeolus-fleet');
  root = join(folder, 'worktrees');
  notes = join(folder, 'notes');
  mkdirSync(notes);
  await git(['init', '-q', '-b', 'main', repository]);
  await commit(repository, 'README.md');
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const scout = { shipId: newId('ship'), shipName: 'scout', workspace: { kind: 'worktree', repository: 'aeolus-fleet' } } as const;

describe('workspaces as per-ship clones', () => {
  it('makes a clone of the repository under the root, one folder per ship, detached at HEAD', async () => {
    const { folder: made } = await workspace().prepare(scout);

    expect(made).toBe(join(root, 'aeolus-fleet', 'scout'));
    expect(existsSync(join(made, 'README.md'))).toBe(true);
    expect((await git(['-C', made, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('HEAD');
    expect((await git(['-C', made, 'rev-parse', 'HEAD'])).trim()).toBe((await git(['-C', repository, 'rev-parse', 'HEAD'])).trim());
  });

  it("holds its own objects, so it works with the repository's objects gone", async () => {
    const { folder: made } = await workspace().prepare(scout);

    rmSync(repository, { recursive: true, force: true });

    expect(existsSync(join(made, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    await git(['-C', made, 'fsck', '--no-progress']);
    expect((await git(['-C', made, 'log', '--format=%s'])).trim()).toBe('README.md');
  });

  it("has a .git of its own, so a hook written in the clone never reaches the repository's .git", async () => {
    const { folder: made } = await workspace().prepare(scout);
    expect(statSync(join(made, '.git')).isDirectory()).toBe(true);
    const marker = join(folder, 'hook-ran');
    const hook = join(made, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(hook, 0o755);

    await commit(repository, 'host.md');

    expect(existsSync(join(repository, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("sets its origin to the repository's own remote, so the session pushes without the host", async () => {
    const upstream = await withUpstream();

    const { folder: made } = await workspace().prepare(scout);

    expect((await git(['-C', made, 'remote', 'get-url', 'origin'])).trim()).toBe(upstream);
    expect((await git(['-C', made, 'remote'])).trim()).toBe('origin');
  });

  it('has no remote when the repository has none, never the repository itself', async () => {
    const { folder: made } = await workspace().prepare(scout);

    expect((await git(['-C', made, 'remote'])).trim()).toBe('');
  });

  it("checks out the settings' ref", async () => {
    await git(['-C', repository, 'tag', 'v1']);
    await commit(repository, 'later.md');

    const { folder: made } = await workspace().prepare({ ...scout, workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'v1' } });

    expect(existsSync(join(made, 'later.md'))).toBe(false);
  });

  it('fetches the repository first and checks out the remote branch for a ref, so a ship starts from current code and not from a stale local branch', async () => {
    await withUpstream();
    const current = join(folder, 'current');
    await git(['clone', '-q', join(folder, 'upstream'), current]);
    await commit(current, 'current.md');
    await git(['-C', current, 'push', '-q', 'origin', 'main']);

    const { folder: made } = await workspace().prepare({ ...scout, workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'main' } });

    expect(existsSync(join(made, 'current.md'))).toBe(true);
    expect((await git(['-C', made, 'rev-parse', 'HEAD'])).trim()).toBe((await git(['-C', current, 'rev-parse', 'HEAD'])).trim());
  });

  it('crews from what it has when the remote cannot be fetched', async () => {
    await git(['-C', repository, 'remote', 'add', 'origin', join(folder, 'gone')]);

    const { folder: made } = await workspace().prepare({ ...scout, workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'main' } });

    expect(existsSync(join(made, 'README.md'))).toBe(true);
  });

  it('uses a clone a stop mid-crew left', async () => {
    const first = await workspace().prepare(scout);

    await expect(workspace().prepare(scout)).resolves.toEqual(first);
  });

  it('says a fresh clone is clean, and one with a change or a new file is not', async () => {
    const { folder: made } = await workspace().prepare(scout);
    expect(await workspace().isClean(made)).toBe(true);

    writeFileSync(join(made, 'notes.md'), 'draft\n');

    expect(await workspace().isClean(made)).toBe(false);
  });

  it('says what removing a clone discards: nothing for a fresh one', async () => {
    await withUpstream();

    const { folder: made } = await workspace().prepare({ ...scout, workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'main' } });

    expect(await workspace().unsaved(made)).toEqual([]);
  });

  it('says what removing a clone discards: each change not committed and each commit no branch, tag or remote branch keeps, and nothing it pushed (#450)', async () => {
    await withUpstream();
    const { folder: made } = await workspace().prepare({ ...scout, workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'main' } });
    await commit(made, 'pushed.md');
    await git(['-C', made, 'push', '-q', 'origin', 'HEAD:refs/heads/pushed']);
    await commit(made, 'done.md');
    writeFileSync(join(made, 'README.md'), 'changed\n');
    writeFileSync(join(made, 'draft.md'), 'draft\n');

    const unsaved = await workspace().unsaved(made);

    const done = (await git(['-C', made, 'rev-parse', '--short', 'HEAD'])).trim();
    expect(unsaved).toEqual([' M README.md', '?? draft.md', `commit ${done} done.md`]);
  });

  it('removes a clone it made', async () => {
    const { folder: made } = await workspace().prepare(scout);

    await workspace().remove(made);

    expect(existsSync(made)).toBe(false);
  });

  it('refuses to remove anything outside its root', async () => {
    await expect(workspace().remove(notes)).rejects.toThrow('removes only what it made');
    expect(existsSync(notes)).toBe(true);
  });

  it('uses a configured folder as it is', async () => {
    await expect(workspace().prepare({ ...scout, workspace: { kind: 'folder', name: 'notes' } })).resolves.toEqual({ folder: notes });
  });

  it('lists the clones under its root, each with its repository and name', async () => {
    await workspace().prepare(scout);
    await workspace().prepare({ ...scout, shipId: newId('ship'), shipName: 'lookout' });

    expect([...(await workspace().worktrees())].sort((first, second) => first.path.localeCompare(second.path))).toEqual([
      { path: join(root, 'aeolus-fleet', 'lookout'), repository: 'aeolus-fleet', name: 'lookout' },
      { path: join(root, 'aeolus-fleet', 'scout'), repository: 'aeolus-fleet', name: 'scout' },
    ]);
  });
});
