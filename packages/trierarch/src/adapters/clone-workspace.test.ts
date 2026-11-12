import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { makeUnmovable, makeUnremovable, moveAsRuntime, removeAsRuntime, unremovableReason } from '../../test/support/unremovable.js';
import { createCloneWorkspace } from './clone-workspace.js';
import { runCommand } from './run-command.js';

// Against the real git, in a temporary folder. A test that plants in the machine's own config does so in a throwaway HOME.

/** The machine's own config as the tests found it, put back after each. */
const MACHINE = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, PATH: process.env.PATH };
/** Whether git-lfs is on the machine: its test runs only where it is. */
const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0;

/** A throwaway HOME whose git config is the machine's own: answers its config file. */
function aThrowawayHome(): string {
  const home = join(folder, 'home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
  return process.env.GIT_CONFIG_GLOBAL;
}

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

function workspace(limits: { timeLimitMs?: number; moveWithinUserNamespace?: (from: string, to: string) => Promise<void> } = {}) {
  return createCloneWorkspace({
    configuration: { ...CONFIGURATION, repositories: { 'aeolus-fleet': { path: repository } }, folders: { notes: { path: notes } } },
    root,
    ...limits,
  });
}

/** A named pipe at the path: git reading it waits for a writer that never comes. */
function aPipe(path: string): void {
  expect(spawnSync('mkfifo', [path]).status).toBe(0);
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
  for (const [name, value] of Object.entries(MACHINE)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
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

  it("checks out through the filters the machine's own config defines, as git-lfs's", async () => {
    writeFileSync(join(repository, '.gitattributes'), '*.txt filter=upper\n');
    writeFileSync(join(repository, 'hello.txt'), 'hello\n');
    await git(['-C', repository, 'add', '.']);
    await git(['-C', repository, 'commit', '-q', '-m', 'hello.txt']);
    await git(['config', '--file', aThrowawayHome(), 'filter.upper.smudge', 'tr a-z A-Z']);

    const { folder: made } = await workspace().prepare(scout);

    expect(readFileSync(join(made, 'hello.txt'), 'utf8')).toBe('HELLO\n');
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

  it.skipIf(unremovableReason !== undefined)('frees its ship\'s place for the trash beside it when the clone holds what the host cannot remove', async () => {
    const { folder: made } = await workspace().prepare(scout);
    makeUnremovable(made);

    try {
      await workspace().remove(made);

      expect(existsSync(made)).toBe(false);
      expect(readdirSync(join(root, 'aeolus-fleet', '.trash'))).toHaveLength(1);
    } finally {
      await removeAsRuntime(folder);
    }
  });

  it('frees its ship\'s place for the trash beside it when its session made the clone\'s own top read-only', async () => {
    const { folder: made } = await workspace().prepare(scout);
    chmodSync(made, 0o555);

    try {
      await workspace().remove(made);

      expect(existsSync(made)).toBe(false);
      expect(readdirSync(join(root, 'aeolus-fleet', '.trash'))).toHaveLength(1);
    } finally {
      // So the test's own folders can go whatever the outcome.
      spawnSync('chmod', ['-R', 'u+rwx', root]);
    }
  });

  it.skipIf(unremovableReason !== undefined)('frees its ship\'s place for the trash beside it within the runtime\'s user namespace when the host cannot move the clone', async () => {
    const { folder: made } = await workspace().prepare(scout);
    makeUnmovable(made);

    try {
      await workspace({ moveWithinUserNamespace: moveAsRuntime }).remove(made);

      expect(existsSync(made)).toBe(false);
      expect(readdirSync(join(root, 'aeolus-fleet', '.trash'))).toHaveLength(1);
    } finally {
      await removeAsRuntime(root);
    }
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

    expect([...(await workspace().foldersUnderRoot())].sort()).toEqual([
      join(root, 'aeolus-fleet', 'lookout'),
      join(root, 'aeolus-fleet', 'scout'),
    ]);
  });

  it('lists each per-ship clone once and ignores a plain clone in the workspace folder (#1295)', async () => {
    await workspace().prepare(scout);
    await git(['clone', '-q', repository, join(root, 'aeolus-fleet-designer-release')]);

    expect(await workspace().foldersUnderRoot()).toEqual([join(root, 'aeolus-fleet', 'scout')]);
  });

  it("lists a per-ship clone once and none of a plain clone's own files in the repository's folder (#1295)", async () => {
    await workspace().prepare(scout);
    mkdirSync(join(root, 'aeolus-fleet', '.git'));
    mkdirSync(join(root, 'aeolus-fleet', 'src'));
    writeFileSync(join(root, 'aeolus-fleet', 'README.md'), 'a plain clone');

    expect(await workspace().foldersUnderRoot()).toEqual([join(root, 'aeolus-fleet', 'scout')]);
  });
});

describe('per-ship clones of a trusted repository the machine does not have (aeolus-fleet#384)', () => {
  function trustedWorkspace(at: { isListed: boolean }) {
    const clones = join(folder, 'repositories');
    return createCloneWorkspace({
      configuration: { ...CONFIGURATION, repositories: at.isListed ? { hemma: { path: join(clones, 'hemma') } } : {}, folders: {} },
      root,
      clones: { root: clones, urlOf: (name) => (at.isListed && name === 'hemma' ? `file://${repository}` : undefined), protocols: 'file' },
    });
  }
  const crew = { shipId: newId('ship'), shipName: 'scout', workspace: { kind: 'worktree', repository: 'hemma' } } as const;

  it("clones the repository first, then the ship's own clone from it", async () => {
    const { folder: made } = await trustedWorkspace({ isListed: true }).prepare(crew);

    expect(made).toBe(join(root, 'hemma', 'scout'));
    expect((await git(['-C', made, 'rev-parse', 'HEAD'])).trim()).toBe((await git(['-C', repository, 'rev-parse', 'HEAD'])).trim());
  });

  it('removes the clone of a ship whose repository left the trusted repositories', async () => {
    const { folder: made } = await trustedWorkspace({ isListed: true }).prepare(crew);

    await trustedWorkspace({ isListed: false }).remove(made);

    expect(existsSync(made)).toBe(false);
  });
});

describe("the host's git calls in a session's clone, with a program named in the clone's own config", () => {
  /** A program that leaves a marker file when anything runs it, under every hook's name in its folder. */
  function aMarkingScript(): { program: string; marker: string } {
    const hooks = join(folder, 'hooks');
    mkdirSync(hooks);
    const marker = join(folder, 'ran');
    const program = join(hooks, 'post-index-change');
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null 2>&1\nexit 0\n`);
    chmodSync(program, 0o755);
    for (const hook of ['pre-commit', 'post-checkout', 'reference-transaction', 'fsmonitor-watchman']) {
      symlinkSync(program, join(hooks, hook));
    }
    return { program, marker };
  }

  const plants: readonly { name: string; plant: (clone: string, program: string) => Promise<unknown> }[] = [
    { name: 'core.fsmonitor', plant: (clone, program) => git(['-C', clone, 'config', 'core.fsmonitor', program]) },
    { name: 'core.hooksPath with a hook', plant: (clone, program) => git(['-C', clone, 'config', 'core.hooksPath', dirname(program)]) },
    {
      name: 'a filter driver',
      plant: async (clone, program) => {
        await git(['-C', clone, 'config', 'filter.planted.clean', program]);
        await git(['-C', clone, 'config', 'filter.planted.smudge', program]);
        writeFileSync(join(clone, '.gitattributes'), '* filter=planted\n');
      },
    },
    { name: 'diff.external', plant: (clone, program) => git(['-C', clone, 'config', 'diff.external', program]) },
    {
      name: 'core.sshCommand',
      plant: async (clone, program) => {
        await git(['-C', clone, 'config', 'core.sshCommand', program]);
        await git(['-C', clone, 'remote', 'set-url', 'origin', 'ssh://git@example.com/aeolus-fleet.git']);
      },
    },
    {
      name: "a filter driver in a submodule's own config",
      plant: async (clone, program) => {
        const module = join(clone, 'module');
        await git(['init', '-q', '-b', 'main', module]);
        await commit(module, 'README.md');
        await git(['-C', clone, 'add', 'module']);
        writeFileSync(join(clone, '.gitmodules'), '[submodule "module"]\n\tpath = module\n\turl = ./module\n');
        await git(['-C', module, 'config', 'filter.planted.clean', program]);
        writeFileSync(join(module, '.gitattributes'), '* filter=planted\n');
        writeFileSync(join(module, 'README.md'), 'README.MD\n');
      },
    },
    {
      name: "a filter driver in the machine's own config",
      plant: async (clone, program) => {
        const machine = aThrowawayHome();
        await git(['config', '--file', machine, 'filter.planted.clean', program]);
        await git(['config', '--file', machine, 'filter.planted.smudge', program]);
        await git(['config', '--file', machine, 'filter.planted.required', 'true']);
        writeFileSync(join(clone, '.gitattributes'), '* filter=planted\n');
      },
    },
    ...(hasLfs
      ? [
          {
            name: "git-lfs's filter, as git lfs install writes it, with an extension in the machine's own config",
            plant: async (clone: string, program: string) => {
              const machine = aThrowawayHome();
              await git(['lfs', 'install', '--skip-repo']);
              await git(['config', '--file', machine, 'lfs.extension.planted.clean', `${program} %f`]);
              await git(['config', '--file', machine, 'lfs.extension.planted.smudge', `${program} %f`]);
              await git(['config', '--file', machine, 'lfs.extension.planted.priority', '0']);
              writeFileSync(join(clone, '.gitattributes'), '*.md filter=lfs diff=lfs merge=lfs\n');
            },
          },
        ]
      : []),
  ];

  it.each(plants)('runs nothing $name names', async ({ plant }) => {
    await withUpstream();
    const { folder: made } = await workspace().prepare(scout);
    const { program, marker } = aMarkingScript();
    await plant(made, program);
    // The same size as before, so git must read the file through its filter to tell whether it changed.
    writeFileSync(join(made, 'README.md'), 'README.MD\n');

    const isClean = await workspace().isClean(made);
    const unsaved = await workspace().unsaved(made);
    await workspace().prepare(scout);

    expect({ isClean, isUnsaved: unsaved.length > 0, hasRun: existsSync(marker) }).toEqual({ isClean: false, isUnsaved: true, hasRun: false });
  });

  it('reads a clone whose config has a section named as a property every object has', async () => {
    await withUpstream();
    const { folder: made } = await workspace().prepare(scout);
    await git(['-C', made, 'config', 'constructor.planted', 'value']);
    writeFileSync(join(made, 'README.md'), 'README.MD\n');

    expect({ isClean: await workspace().isClean(made), unsaved: await workspace().unsaved(made) }).toEqual({ isClean: false, unsaved: [' M README.md'] });
  });
});

describe("the host's git calls in a session's clone, with a signed commit and the clone's config asking log to show signatures", () => {
  /** A commit on top of the clone's HEAD carrying a signature, made HEAD: answers its subject. */
  async function aSignedCommit(clone: string): Promise<string> {
    const tree = (await git(['-C', clone, 'rev-parse', 'HEAD^{tree}'])).trim();
    const parent = (await git(['-C', clone, 'rev-parse', 'HEAD'])).trim();
    const object = `tree ${tree}\nparent ${parent}\nauthor a <a@example.com> 0 +0000\ncommitter a <a@example.com> 0 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n c2lnbmVk\n -----END PGP SIGNATURE-----\n\nsigned\n`;
    const hashed = await runCommand('git', { args: ['-C', clone, 'hash-object', '-t', 'commit', '-w', '--stdin'], input: object });
    expect(hashed.status, hashed.stderr).toBe(0);
    await git(['-C', clone, 'update-ref', '--no-deref', 'HEAD', hashed.stdout.trim()]);
    return 'signed';
  }

  /** One program under each name git runs to check a signature, first on PATH, leaving a marker when anything runs it: answers the marker. */
  function signatureProgramsOnPath(): string {
    const programs = join(folder, 'programs');
    mkdirSync(programs);
    const marker = join(folder, 'ran');
    for (const name of ['gpg', 'gpgsm', 'ssh-keygen']) {
      writeFileSync(join(programs, name), `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null 2>&1\nexit 0\n`);
      chmodSync(join(programs, name), 0o755);
    }
    process.env.PATH = `${programs}:${process.env.PATH ?? ''}`;
    return marker;
  }

  it("lists the commit as unsaved and checks no commit's signature", async () => {
    const { folder: made } = await workspace().prepare(scout);
    const subject = await aSignedCommit(made);
    await git(['-C', made, 'config', 'log.showSignature', 'true']);
    const marker = signatureProgramsOnPath();

    const unsaved = await workspace().unsaved(made);

    expect({ unsaved: unsaved.map((line) => line.split(' ').at(-1)), hasRun: existsSync(marker) }).toEqual({ unsaved: [subject], hasRun: false });
  });
});

describe("the host's git calls in a session's clone, with the clone's git pointed at another folder", () => {
  /** Another repository on the host, with a change of its own, where the clone's git is pointed. */
  async function anotherRepository(): Promise<string> {
    const other = join(folder, 'other');
    await git(['init', '-q', '-b', 'main', other]);
    await commit(other, 'OTHER.md');
    writeFileSync(join(other, 'OTHER.md'), 'CHANGED\n');
    return other;
  }

  const pointings: readonly { name: string; reason: string; point: (clone: string, other: string) => unknown }[] = [
    { name: 'core.worktree in its config', reason: 'its config sets core.worktree, which points git at another folder', point: (clone, other) => git(['-C', clone, 'config', 'core.worktree', other]) },
    {
      name: 'a .git file naming another git folder',
      reason: 'its .git is no folder of its own',
      point: (clone, other) => {
        renameSync(join(clone, '.git'), join(folder, 'moved.git'));
        writeFileSync(join(clone, '.git'), `gitdir: ${join(other, '.git')}\n`);
      },
    },
    {
      name: 'a .git link to another git folder',
      reason: 'its .git is no folder of its own',
      point: (clone, other) => {
        renameSync(join(clone, '.git'), join(folder, 'moved.git'));
        symlinkSync(join(other, '.git'), join(clone, '.git'));
      },
    },
    {
      name: 'a commondir in its .git naming another git folder',
      reason: 'its .git names another git folder in its commondir',
      point: (clone, other) => {
        writeFileSync(join(clone, '.git', 'commondir'), `${join(other, '.git')}\n`);
      },
    },
    {
      name: "an alternates file naming another repository's objects",
      reason: "its .git names another repository's objects in objects/info/alternates",
      point: (clone, other) => {
        writeFileSync(join(clone, '.git', 'objects', 'info', 'alternates'), `${join(other, '.git', 'objects')}\n`);
      },
    },
    ...['objects', 'config', 'HEAD', join('refs', 'heads')].map((inGit) => ({
      name: `a link as its .git's ${inGit}`,
      reason: `its .git holds a link: ${inGit}`,
      point: (clone: string, other: string) => {
        rmSync(join(clone, '.git', inGit), { recursive: true, force: true });
        symlinkSync(join(other, '.git', inGit), join(clone, '.git', inGit));
      },
    })),
    ...['lfs.extension.planted.clean', 'lfs.customtransfer.planted.path'].map((name) => ({
      name: `${name} in its config`,
      reason: `its config names a program for git-lfs: ${name}`,
      point: (clone: string) => git(['-C', clone, 'config', name, join(folder, 'program')]),
    })),
    ...['HEAD', 'config', 'packed-refs'].map((inGit) => ({
      name: `a named pipe as its .git's ${inGit}`,
      reason: `its .git holds a special file: ${inGit}`,
      point: (clone: string) => {
        rmSync(join(clone, '.git', inGit), { force: true });
        aPipe(join(clone, '.git', inGit));
      },
    })),
    {
      name: 'an include in its config of a named pipe in its work tree',
      reason: 'its config includes a file outside its .git: ../planted',
      point: async (clone: string) => {
        aPipe(join(clone, 'planted'));
        await git(['-C', clone, 'config', 'include.path', '../planted']);
      },
    },
    {
      name: 'an include in a file its config includes of a named pipe in its work tree',
      reason: 'its config includes a file outside its .git: ../planted',
      point: async (clone: string) => {
        aPipe(join(clone, 'planted'));
        await git(['config', '--file', join(clone, '.git', 'inner'), 'include.path', '../planted']);
        await git(['-C', clone, 'config', 'include.path', 'inner']);
      },
    },
    ...[
      { name: 'extensions.partialclone', isPartialClone: true },
      { name: 'remote.other.promisor', isPartialClone: false },
    ].map(({ name, isPartialClone }) => ({
      name: `${name} in its config, at a commit only another repository has`,
      reason: `its config names a remote to fetch missing objects from: ${name}`,
      point: async (clone: string, other: string) => {
        await git(['-C', clone, 'config', 'core.repositoryformatversion', '1']);
        if (isPartialClone) {
          await git(['-C', clone, 'config', 'extensions.partialClone', 'other']);
        }
        await git(['-C', clone, 'config', 'remote.other.url', other]);
        await git(['-C', clone, 'config', 'remote.other.promisor', 'true']);
        writeFileSync(join(clone, '.git', 'HEAD'), await git(['-C', other, 'rev-parse', 'HEAD']));
      },
    })),
  ];

  it.each(pointings)('reads a clone with $name as unsaved and not clean, refused, saying why', async ({ point, reason }) => {
    const { folder: made } = await workspace().prepare(scout);
    await point(made, await anotherRepository());

    expect({ unsaved: await workspace().unsaved(made), isClean: await workspace().isClean(made) }).toEqual({ unsaved: [`refused, ${reason}`], isClean: false });
  });
});

describe("the host's git calls in a session's clone, with a file in its work tree git waits on", () => {
  it('reads a clone whose git call does not end within its time limit as unsaved and not clean, refused, saying why', async () => {
    const { folder: made } = await workspace().prepare(scout);
    aPipe(join(made, '.gitignore'));
    const limited = workspace({ timeLimitMs: 2000 });

    expect({ unsaved: await limited.unsaved(made), isClean: await limited.isClean(made) }).toEqual({ unsaved: ['refused, git status did not end within 2 seconds'], isClean: false });
  });
});

describe("the host's reads of a session's clone, with a file the clone's config names for git", () => {
  it.each(['core.excludesFile', 'core.attributesFile', 'mailmap.file'])('reads no file %s names', async (name) => {
    const { folder: made } = await workspace().prepare(scout);
    const planted = join(folder, 'planted');
    aPipe(planted);
    await git(['-C', made, 'config', name, planted]);
    // The same size as before, so git must read the file to tell whether it changed.
    writeFileSync(join(made, 'README.md'), 'README.MD\n');

    expect(await workspace({ timeLimitMs: 2000 }).unsaved(made)).toEqual([' M README.md']);
  });

  it('reads no mailmap in the clone when it reads its log', async () => {
    const { folder: made } = await workspace().prepare(scout);
    await commit(made, 'notes.md');
    aPipe(join(made, '.mailmap'));

    const unsaved = await workspace({ timeLimitMs: 2000 }).unsaved(made);

    expect({ isListed: unsaved.some((line) => line.endsWith(' notes.md')), isRefused: unsaved.some((line) => line.startsWith('refused, ')) }).toEqual({ isListed: true, isRefused: false });
  });
});

describe("the host's git calls in a session's clone, with a config git cannot read", () => {
  it('reads the clone as unsaved and not clean, refused, saying what git said', async () => {
    const { folder: made } = await workspace().prepare(scout);
    writeFileSync(join(made, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n=garbage\n');

    expect({ unsaved: await workspace().unsaved(made), isClean: await workspace().isClean(made) }).toEqual({
      unsaved: [`refused, git config failed: fatal: bad config line 3 in file ${join(made, '.git', 'config')}`],
      isClean: false,
    });
  });
});
