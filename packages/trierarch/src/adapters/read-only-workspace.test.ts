import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { createGitWorkspace } from './git-workspace.js';
import { createReadOnlyWorkspace } from './read-only-workspace.js';
import { runCommand } from './run-command.js';

// Against the real git, in a temporary folder. Read-only is the file system's: the tests run as a user other than root.

const AUTHOR = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };

let folder: string;
let root: string;
let company: string;
let fleet: string;
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

function workspaces() {
  const configuration = { ...CONFIGURATION, repositories: { 'aeolus-company': { path: company }, 'aeolus-fleet': { path: fleet } }, folders: {} };
  return createReadOnlyWorkspace({ configuration, root, readOnly: ['aeolus-company'], workspaces: createGitWorkspace({ configuration, root }) });
}

const company1 = { shipId: newId('ship'), shipName: 'chief-of-staff', workspace: { kind: 'worktree', repository: 'aeolus-company', ref: 'main' } } as const;

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-read-only-workspace-'));
  root = join(folder, 'worktrees');
  company = await aRepository('aeolus-company');
  fleet = await aRepository('aeolus-fleet');
  // The company repository's checkout on the machine has a remote, whose main moves on.
  upstream = join(folder, 'aeolus-company-upstream');
  await git(['clone', '-q', company, upstream]);
  await git(['-C', company, 'remote', 'add', 'origin', upstream]);
  await git(['-C', company, 'fetch', '-q', 'origin']);
});

afterEach(async () => {
  // Read-only workspaces a test left are made writable again so they can go.
  await runCommand('chmod', { args: ['-R', 'u+w', folder] });
  rmSync(folder, { recursive: true, force: true });
});

describe('a read-only workspace (aeolus-fleet#1449)', () => {
  it('makes the workspace of a read-only repository on main, its HEAD the latest origin/main, and says it is read-only', async () => {
    const latest = await commit(upstream, 'rule.md');

    const made = await workspaces().prepare(company1);

    const workspace = join(root, 'aeolus-company', 'chief-of-staff');
    expect(made).toEqual({ folder: workspace, isReadOnly: true });
    expect(await git(['-C', workspace, 'branch', '--show-current'])).toBe('main');
    expect(await git(['-C', workspace, 'rev-parse', 'HEAD'])).toBe(latest);
    expect(await git(['-C', workspace, 'rev-parse', 'origin/main'])).toBe(latest);
  });

  it('lets the session change no file in a read-only workspace', async () => {
    const { folder: workspace } = await workspaces().prepare(company1);

    expect(() => {
      writeFileSync(join(workspace, 'README.md'), 'changed\n');
    }).toThrow(/EACCES/);
    expect(() => {
      writeFileSync(join(workspace, 'new.md'), 'new\n');
    }).toThrow(/EACCES/);
  });

  it('gives a read-only workspace no remote to push to', async () => {
    const { folder: workspace } = await workspaces().prepare(company1);

    expect(await git(['-C', workspace, 'remote'])).toBe('');
  });

  it('makes a worktree, as ever, for a repository that is not read-only', async () => {
    const made = await workspaces().prepare({ ...company1, workspace: { kind: 'worktree', repository: 'aeolus-fleet' } });

    expect(made).toEqual({ folder: join(root, 'aeolus-fleet', 'chief-of-staff') });
    expect(await git(['-C', fleet, 'worktree', 'list'])).toContain(made.folder);
  });

  it('keeps a read-only workspace the ship has already', async () => {
    const { folder: workspace } = await workspaces().prepare(company1);
    const before = await git(['-C', workspace, 'rev-parse', 'HEAD']);
    await commit(upstream, 'rule.md');

    await workspaces().prepare(company1);

    expect(await git(['-C', workspace, 'rev-parse', 'HEAD'])).toBe(before);
  });

  it('refreshes a read-only workspace to the latest main, answering the revision it now holds, read-only still', async () => {
    const { folder: workspace } = await workspaces().prepare(company1);
    const latest = await commit(upstream, 'rule.md');

    const refreshed = await workspaces().refresh({ repository: 'aeolus-company', folder: workspace });

    expect(refreshed).toEqual({ repository: 'aeolus-company', revision: latest });
    expect(await git(['-C', workspace, 'branch', '--show-current'])).toBe('main');
    expect(() => {
      writeFileSync(join(workspace, 'rule.md'), 'changed\n');
    }).toThrow(/EACCES/);
  });

  it('answers a problem, never the main it held, when the remote cannot be fetched', async () => {
    const { folder: workspace } = await workspaces().prepare(company1);
    const held = await git(['-C', workspace, 'rev-parse', 'HEAD']);
    rmSync(upstream, { recursive: true, force: true });

    const refreshed = await workspaces().refresh({ repository: 'aeolus-company', folder: workspace });

    expect(refreshed !== undefined && 'problem' in refreshed ? refreshed.problem : undefined).toContain('fetch');
    expect(await git(['-C', workspace, 'rev-parse', 'HEAD'])).toBe(held);
  });

  it('refreshes no workspace of a repository that is not read-only', async () => {
    const { folder: workspace } = await workspaces().prepare({ ...company1, workspace: { kind: 'worktree', repository: 'aeolus-fleet' } });

    await expect(workspaces().refresh({ repository: 'aeolus-fleet', folder: workspace })).resolves.toBeUndefined();
  });

  it('knows a read-only workspace as one it made, clean, and lists it', async () => {
    const { folder: workspace } = await workspaces().prepare(company1);

    await expect(workspaces().isMade(workspace)).resolves.toBe(true);
    await expect(workspaces().isClean(workspace)).resolves.toBe(true);
    await expect(workspaces().unsaved(workspace)).resolves.toEqual([]);
    await expect(workspaces().worktrees()).resolves.toEqual([{ path: workspace, repository: 'aeolus-company', name: 'chief-of-staff' }]);
  });

  it('removes a read-only workspace, read-only as it is', async () => {
    const { folder: workspace } = await workspaces().prepare(company1);

    await workspaces().remove(workspace);

    expect(existsSync(workspace)).toBe(false);
  });

  it('removes a worktree of a repository that is not read-only as a worktree', async () => {
    const { folder: worktree } = await workspaces().prepare({ ...company1, workspace: { kind: 'worktree', repository: 'aeolus-fleet' } });

    await workspaces().remove(worktree);

    expect(existsSync(worktree)).toBe(false);
    expect(await git(['-C', fleet, 'worktree', 'list'])).not.toContain('chief-of-staff');
  });
});
