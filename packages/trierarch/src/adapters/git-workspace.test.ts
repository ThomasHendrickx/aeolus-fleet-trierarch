import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

function workspace(at: { before?: string } = {}) {
  return createGitWorkspace({
    configuration: { ...CONFIGURATION, repositories: { 'aeolus-fleet': { path: repository } }, folders: { notes: { path: notes } } },
    root,
    ...at,
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

  it('says what removing a worktree discards: nothing for a fresh one', async () => {
    const { folder: made } = await workspace().prepare(scout);

    expect(await workspace().unsaved(made)).toEqual([]);
  });

  it('says what removing a worktree discards: each change not committed, as git status shows it, and each commit no branch, tag or remote branch keeps (#450)', async () => {
    const upstream = join(folder, 'upstream');
    await git(['clone', '-q', repository, upstream]);
    await git(['-C', repository, 'remote', 'add', 'origin', upstream]);
    const { folder: made } = await workspace().prepare({ ...scout, workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'main' } });
    writeFileSync(join(made, 'done.md'), 'done\n');
    await git(['-C', made, 'add', '.']);
    await git(['-C', made, 'commit', '-q', '-m', 'work not pushed']);
    writeFileSync(join(made, 'README.md'), 'changed\n');
    writeFileSync(join(made, 'draft.md'), 'draft\n');

    const unsaved = await workspace().unsaved(made);

    const commit = (await git(['-C', made, 'rev-parse', '--short', 'HEAD'])).trim();
    expect(unsaved).toEqual([' M README.md', '?? draft.md', `commit ${commit} work not pushed`]);
  });

  it('removes a worktree it made', async () => {
    const { folder: made } = await workspace().prepare(scout);

    await workspace().remove(made);

    expect(existsSync(made)).toBe(false);
    expect(await git(['-C', repository, 'worktree', 'list'])).not.toContain('scout');
  });

  it('refuses to remove anything outside its root', async () => {
    await expect(workspace().remove(notes)).rejects.toThrow('removes only a folder under the root');
    expect(existsSync(notes)).toBe(true);
  });

  it('uses a configured folder as it is', async () => {
    await expect(workspace().prepare({ ...scout, workspace: { kind: 'folder', name: 'notes' } })).resolves.toEqual({ folder: notes });
  });

  it('lists every folder under its root no matter what made it: a worktree, a plain clone, a folder git does not know, a worktree of another repository in its folder, never the trash (gap rule 2)', async () => {
    await workspace().prepare(scout);
    await git(['clone', '-q', repository, join(root, 'aeolus-fleet', 'own-clone')]);
    mkdirSync(join(root, 'hemma', 'notes'), { recursive: true });
    const other = join(folder, 'aeolus-fleet-gateway');
    await git(['init', '-q', '-b', 'main', other]);
    await git(['-C', other, 'commit', '-q', '--allow-empty', '-m', 'init']);
    await git(['-C', other, 'worktree', 'add', '-q', '--detach', join(root, 'aeolus-fleet', 'aeolus-fleet-gateway')]);
    mkdirSync(join(root, 'aeolus-fleet', '.trash'));
    writeFileSync(join(root, 'aeolus-fleet', 'notes.md'), 'a file, no folder\n');

    expect([...(await workspace().foldersUnderRoot())].sort()).toEqual(
      [join(root, 'aeolus-fleet', 'aeolus-fleet-gateway'), join(root, 'aeolus-fleet', 'own-clone'), join(root, 'aeolus-fleet', 'scout'), join(root, 'hemma'), join(root, 'hemma', 'notes')].sort(),
    );
  });

  it('lists a folder straight under its root that is no repository it has as itself and each folder in it, but a repository\'s own folder or one holding the trash only by what it holds (gap rule 2)', async () => {
    await workspace().prepare(scout);
    mkdirSync(join(root, 'workbench', 'tools'), { recursive: true });
    mkdirSync(join(root, 'left-repository', '.trash'), { recursive: true });
    mkdirSync(join(root, 'left-repository', 'lookout'));
    symlinkSync(notes, join(root, 'linked'));

    expect([...(await workspace().foldersUnderRoot())].sort()).toEqual(
      [join(root, 'aeolus-fleet', 'scout'), join(root, 'left-repository', 'lookout'), join(root, 'workbench'), join(root, 'workbench', 'tools')].sort(),
    );
  });

  it('removes a folder straight under its root that git does not know', async () => {
    const workbench = join(root, 'workbench');
    mkdirSync(join(workbench, 'tools'), { recursive: true });

    await workspace().remove(workbench);

    expect(existsSync(workbench)).toBe(false);
  });

  it('lists a workspace placed straight under its root as one folder, none of its own files (#1295, gap rule 2)', async () => {
    await workspace().prepare(scout);
    await git(['clone', '-q', repository, join(root, 'aeolus-fleet-designer-release')]);

    expect([...(await workspace().foldersUnderRoot())].sort()).toEqual([join(root, 'aeolus-fleet', 'scout'), join(root, 'aeolus-fleet-designer-release')].sort());
  });

  it('lists no link under its root, so nothing it points at is removed', async () => {
    mkdirSync(join(root, 'aeolus-fleet'), { recursive: true });
    symlinkSync(notes, join(root, 'aeolus-fleet', 'notes'));

    expect(await workspace().foldersUnderRoot()).toEqual([]);
  });

  it('removes a plain clone, a folder git does not know and a worktree of another repository under its root (gap rule 2)', async () => {
    const plain = join(root, 'aeolus-fleet', 'own-clone');
    await git(['clone', '-q', repository, plain]);
    const unknown = join(root, 'hemma', 'notes');
    mkdirSync(join(unknown, 'deep'), { recursive: true });
    const other = join(folder, 'aeolus-fleet-gateway');
    await git(['init', '-q', '-b', 'main', other]);
    await git(['-C', other, 'commit', '-q', '--allow-empty', '-m', 'init']);
    const foreign = join(root, 'aeolus-fleet', 'aeolus-fleet-gateway');
    await git(['-C', other, 'worktree', 'add', '-q', '--detach', foreign]);

    for (const stray of [plain, unknown, foreign]) {
      await workspace().remove(stray);
    }

    expect([plain, unknown, foreign].filter((stray) => existsSync(stray))).toEqual([]);
    expect(existsSync(other)).toBe(true);
  });

  it('refuses to remove its root, the trash or a folder deeper than a workspace', async () => {
    const { folder: made } = await workspace().prepare(scout);
    mkdirSync(join(root, 'aeolus-fleet', '.trash'));

    for (const kept of [root, join(root, 'aeolus-fleet', '.trash'), join(made, 'src')]) {
      await expect(workspace().remove(kept)).rejects.toThrow('removes only a folder under the root');
    }
    expect(existsSync(join(root, 'aeolus-fleet', '.trash'))).toBe(true);
  });

  it('lists the worktrees under a root reached through a symbolic link, as macOS reaches /var through /private/var (aeolus-fleet#1340)', async () => {
    mkdirSync(join(folder, 'real-worktrees'));
    symlinkSync(join(folder, 'real-worktrees'), root);
    await workspace().prepare(scout);

    expect(await workspace().foldersUnderRoot()).toEqual([join(root, 'aeolus-fleet', 'scout')]);
  });
});

describe("a ship's folder, under the place of ships/", () => {
  it('is the folder of the ship id under the place of ships/', async () => {
    await expect(workspace().shipFolderOf(scout.shipId)).resolves.toBe(join(root, scout.shipId));
  });

  it("holds the worktree of a ship crewed fresh, for its owner alone", async () => {
    const shipFolder = await workspace().shipFolderOf(scout.shipId);

    const { folder: made } = await workspace().prepare({ ...scout, shipFolder });

    expect([made, existsSync(join(made, 'README.md')), statSync(shipFolder).mode & 0o777]).toEqual([join(shipFolder, 'worktree'), true, 0o700]);
  });

  it('goes whole into the trash beside it, whatever it holds', async () => {
    const shipFolder = await workspace().shipFolderOf(scout.shipId);
    const { folder: made } = await workspace().prepare({ ...scout, shipFolder });
    mkdirSync(join(shipFolder, 'sockets'));
    writeFileSync(join(made, 'unsaved.txt'), 'unsaved\n');

    await workspace().removeShipFolder(shipFolder);

    expect(existsSync(shipFolder)).toBe(false);
    expect(readdirSync(join(root, '.trash')).map((name) => name.startsWith(`${scout.shipId}.`))).toEqual([true]);
  });

  it('is removed already when it is gone', async () => {
    await expect(workspace().removeShipFolder(join(root, scout.shipId))).resolves.toBeUndefined();
  });

  it('of a ship in a configured folder goes, and the configured folder stays', async () => {
    const shipFolder = await workspace().shipFolderOf(scout.shipId);
    const { folder: made } = await workspace().prepare({ ...scout, workspace: { kind: 'folder', name: 'notes' }, shipFolder });
    mkdirSync(join(shipFolder, 'sockets'), { recursive: true });

    await workspace().removeShipFolder(shipFolder);

    expect([made, existsSync(shipFolder), existsSync(notes)]).toEqual([notes, false, true]);
  });
});

describe('the worktrees of the ships crewed before the ship folders', () => {
  it('stay under the root they were made in, and are removed there', async () => {
    const before = join(folder, 'before');

    const { folder: made } = await workspace({ before }).prepare(scout);
    await workspace({ before }).remove(made);

    expect([made, existsSync(made)]).toEqual([join(before, 'aeolus-fleet', 'scout'), false]);
  });

  it("are listed and removed beside the ships' folders, as every folder under either root is", async () => {
    const before = join(folder, 'before');
    const orphan = join(before, 'aeolus-fleet', 'orphan');
    const stray = join(root, newId('ship'));
    mkdirSync(join(before, 'aeolus-fleet'), { recursive: true });
    mkdirSync(join(stray, 'sockets'), { recursive: true });
    await git(['-C', repository, 'worktree', 'add', '-q', '--detach', orphan]);

    const listed = await workspace({ before }).foldersUnderRoot();
    await workspace({ before }).remove(orphan);
    await workspace({ before }).remove(stray);

    expect(listed).toEqual(expect.arrayContaining([orphan, stray]));
    expect([existsSync(orphan), existsSync(stray)]).toEqual([false, false]);
  });
});

describe('workspaces of a trusted repository the machine does not have (aeolus-fleet#384)', () => {
  let clones: string;
  let hemma: string;

  beforeEach(() => {
    clones = join(folder, 'repositories');
    hemma = join(clones, 'hemma');
  });

  /** The workspace offering hemma from the trusted repositories at the URL given; in a test git clones a file URL, as a remote. */
  function trustedWorkspace(at: { url: string | undefined; protocols?: string; isListed?: boolean }) {
    const isListed = at.isListed ?? true;
    return createGitWorkspace({
      configuration: { ...CONFIGURATION, repositories: isListed ? { hemma: { path: hemma } } : {}, folders: {} },
      root,
      clones: { root: clones, urlOf: (name) => (name === 'hemma' ? at.url : undefined), ...(at.protocols !== undefined && { protocols: at.protocols }) },
    });
  }
  const remote = () => `file://${repository}`;
  const crew = { shipId: newId('ship'), shipName: 'scout', workspace: { kind: 'worktree', repository: 'hemma' } } as const;

  it('clones it first, with the machine\'s own access, then makes the worktree from the clone', async () => {
    const { folder: made } = await trustedWorkspace({ url: remote(), protocols: 'file' }).prepare(crew);

    expect(made).toBe(join(root, 'hemma', 'scout'));
    expect(existsSync(join(made, 'README.md'))).toBe(true);
    expect((await git(['-C', hemma, 'remote', 'get-url', 'origin'])).trim()).toBe(remote());
  });

  it('clones it once: a second ship gets a worktree of the same clone, fetched first', async () => {
    const workspace = trustedWorkspace({ url: remote(), protocols: 'file' });
    await workspace.prepare(crew);
    writeFileSync(join(repository, 'later.md'), 'later\n');
    await git(['-C', repository, 'add', '.']);
    await git(['-C', repository, 'commit', '-q', '-m', 'later']);

    const { folder: second } = await workspace.prepare({ ...crew, shipName: 'second', workspace: { kind: 'worktree', repository: 'hemma', ref: 'main' } });

    expect(existsSync(join(second, 'later.md'))).toBe(true);
  });

  it('clones it again when a stop left a clone half made', async () => {
    mkdirSync(`${hemma}.partial`, { recursive: true });
    writeFileSync(join(`${hemma}.partial`, 'half'), '');

    const { folder: made } = await trustedWorkspace({ url: remote(), protocols: 'file' }).prepare(crew);

    expect(existsSync(join(made, 'README.md'))).toBe(true);
    expect(existsSync(`${hemma}.partial`)).toBe(false);
  });

  it('clones over https or ssh only, whatever URL reached it', async () => {
    await expect(trustedWorkspace({ url: remote() }).prepare(crew)).rejects.toThrow(/git clone of hemma failed/);

    expect(existsSync(hemma)).toBe(false);
  });

  it('fails with git\'s reason and leaves no clone when the machine cannot clone it', async () => {
    await expect(trustedWorkspace({ url: `file://${join(folder, 'gone')}`, protocols: 'file' }).prepare(crew)).rejects.toThrow(/git clone of hemma failed: .+/);

    expect(existsSync(hemma)).toBe(false);
    expect(existsSync(`${hemma}.partial`)).toBe(false);
  });

  it('removes a worktree of a clone whose repository left the trusted repositories', async () => {
    const { folder: made } = await trustedWorkspace({ url: remote(), protocols: 'file' }).prepare(crew);

    await trustedWorkspace({ url: undefined, isListed: false }).remove(made);

    expect(existsSync(made)).toBe(false);
  });
});

describe('pruning the worktree records of a configured repository (#91)', () => {
  it('prunes the record of a worktree whose folder is gone and leaves a live worktree outside its root alone', async () => {
    const gone = join(folder, 'elsewhere', 'gone');
    const live = join(folder, 'elsewhere', 'live');
    await git(['-C', repository, 'worktree', 'add', '--detach', gone]);
    await git(['-C', repository, 'worktree', 'add', '--detach', live]);
    rmSync(gone, { recursive: true });

    await workspace().prune('aeolus-fleet');

    const listed = await git(['-C', repository, 'worktree', 'list', '--porcelain']);
    expect(listed).not.toContain(`worktree ${gone}`);
    expect(listed).toContain(`worktree ${live}`);
    expect(existsSync(live)).toBe(true);
  });

  it('fails the prune of a repository the configuration does not have', async () => {
    await expect(workspace().prune('unknown')).rejects.toThrow('unknown');
  });
});

describe('deleting the local branches of a configured repository whose remote branch is gone (#92)', () => {
  let remote: string;

  /** A branch of the repository pushed to the remote, the local branch tracking it. */
  async function aPushedBranch(name: string): Promise<void> {
    await git(['-C', repository, 'branch', name]);
    await git(['-C', repository, 'push', '-q', '-u', 'origin', name]);
  }

  async function branches(): Promise<string[]> {
    return (await git(['-C', repository, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter((line) => line !== '');
  }

  beforeEach(async () => {
    remote = join(folder, 'remote.git');
    await git(['init', '-q', '--bare', remote]);
    await git(['-C', repository, 'remote', 'add', 'origin', remote]);
    await git(['-C', repository, 'push', '-q', '-u', 'origin', 'main']);
  });

  it('deletes a local branch checked out nowhere whose remote branch is gone from the remote', async () => {
    await aPushedBranch('merged');
    await git(['-C', remote, 'branch', '-D', 'merged']);

    await workspace().deleteBranchesWhoseRemoteBranchIsGone('aeolus-fleet');

    expect(await branches()).not.toContain('merged');
  });

  it('keeps a local branch whose remote branch exists', async () => {
    await aPushedBranch('open');

    await workspace().deleteBranchesWhoseRemoteBranchIsGone('aeolus-fleet');

    expect(await branches()).toContain('open');
  });

  it('keeps a local branch whose remote branch is gone while a worktree has it checked out', async () => {
    await aPushedBranch('in-use');
    await git(['-C', repository, 'worktree', 'add', '-q', join(folder, 'elsewhere', 'in-use'), 'in-use']);
    await git(['-C', remote, 'branch', '-D', 'in-use']);

    await workspace().deleteBranchesWhoseRemoteBranchIsGone('aeolus-fleet');

    expect(await branches()).toContain('in-use');
  });

  it('keeps a local branch that never had a remote branch', async () => {
    await git(['-C', repository, 'branch', 'kept-by-a-person']);

    await workspace().deleteBranchesWhoseRemoteBranchIsGone('aeolus-fleet');

    expect(await branches()).toContain('kept-by-a-person');
  });

  it('keeps the branch the repository has checked out, its remote branch gone too', async () => {
    await git(['-C', repository, 'switch', '-q', '-c', 'current']);
    await git(['-C', repository, 'push', '-q', '-u', 'origin', 'current']);
    await git(['-C', remote, 'branch', '-D', 'current']);

    await workspace().deleteBranchesWhoseRemoteBranchIsGone('aeolus-fleet');

    expect(await branches()).toContain('current');
  });

  it('judges a branch by the remote and remote branch its upstream names, whatever their names', async () => {
    const other = join(folder, 'other.git');
    await git(['init', '-q', '--bare', other]);
    await git(['-C', repository, 'remote', 'add', 'upstream', other]);
    await git(['-C', repository, 'branch', 'mine-merged']);
    await git(['-C', repository, 'push', '-q', '-u', 'upstream', 'mine-merged:theirs-merged']);
    await git(['-C', repository, 'branch', 'mine-open']);
    await git(['-C', repository, 'push', '-q', '-u', 'upstream', 'mine-open:theirs-open']);
    await git(['-C', other, 'branch', '-D', 'theirs-merged']);

    await workspace().deleteBranchesWhoseRemoteBranchIsGone('aeolus-fleet');

    expect(await branches()).not.toContain('mine-merged');
    expect(await branches()).toContain('mine-open');
  });

  it('keeps a branch whose upstream is a local branch, the repository itself its remote', async () => {
    await git(['-C', repository, 'branch', '--track', 'follows-main', 'main']);

    await workspace().deleteBranchesWhoseRemoteBranchIsGone('aeolus-fleet');

    expect(await branches()).toContain('follows-main');
  });

  it('fails and deletes nothing when the remote cannot be read, so a branch is never taken for gone', async () => {
    await aPushedBranch('merged');
    rmSync(remote, { recursive: true });

    await expect(workspace().deleteBranchesWhoseRemoteBranchIsGone('aeolus-fleet')).rejects.toThrow('ls-remote');
    expect(await branches()).toContain('merged');
  });

  it('fails for a repository the configuration does not have', async () => {
    await expect(workspace().deleteBranchesWhoseRemoteBranchIsGone('unknown')).rejects.toThrow('unknown');
  });
});
