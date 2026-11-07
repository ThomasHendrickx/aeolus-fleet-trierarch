import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitInFolder, RefusedRead } from './git-in-folder.js';
import { runCommand } from './run-command.js';

// Against the real git, in a temporary folder. A git without hooks in its config runs none either way.

let folder: string;
let repository: string;

async function git(args: readonly string[]): Promise<void> {
  const result = await runCommand('git', { args, env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' } });
  expect(result.status, result.stderr).toBe(0);
}

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-git-in-folder-'));
  repository = join(folder, 'scout');
  await git(['init', '-q', '-b', 'main', repository]);
  writeFileSync(join(repository, 'README.md'), 'README.md\n');
  await git(['-C', repository, 'add', '.']);
  await git(['-C', repository, 'commit', '-q', '-m', 'README.md']);
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("the host's git calls in a ship's folder, with a hook named in the folder's own config", () => {
  it('runs no hook the config names for an event', async () => {
    const marker = join(folder, 'ran');
    const program = join(folder, 'hook');
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null 2>&1\nexit 0\n`);
    chmodSync(program, 0o755);
    await git(['-C', repository, 'config', 'hook.planted.command', program]);
    for (const event of ['reference-transaction', 'post-checkout', 'post-index-change']) {
      await git(['-C', repository, 'config', '--add', 'hook.planted.event', event]);
    }

    const checkout = await gitInFolder(repository, ['checkout', '--quiet', '--detach', 'HEAD']);
    const status = await gitInFolder(repository, ['status', '--porcelain']);

    expect({ checkout: checkout.status, status: status.status, hasRun: existsSync(marker) }).toEqual({ checkout: 0, status: 0, hasRun: false });
  });
});

describe("the host's git calls in a ship's folder, with a remote in the folder's own config to fetch missing objects from", () => {
  it('fetches no object the folder lacks', async () => {
    const other = join(folder, 'other');
    await git(['init', '-q', '-b', 'main', other]);
    writeFileSync(join(other, 'OTHER.md'), 'OTHER.md\n');
    await git(['-C', other, 'add', '.']);
    await git(['-C', other, 'commit', '-q', '-m', 'only in the other repository']);
    await git(['-C', repository, 'config', 'remote.other.url', other]);
    await git(['-C', repository, 'config', 'remote.other.promisor', 'true']);
    const missing = (await runCommand('git', { args: ['-C', other, 'rev-parse', 'HEAD'] })).stdout.trim();

    const log = await gitInFolder(repository, ['log', '--format=%s', missing]);

    expect({ isFailed: log.status !== 0, stdout: log.stdout }).toEqual({ isFailed: true, stdout: '' });
  });
});

describe("the host's git calls in a ship's worktree, with its own git folder holding what is not a file of its own", () => {
  const plants: readonly { name: string; reason: string; plant: (gitFolder: string, worktree: string) => void }[] = [
    {
      name: 'a link as its HEAD',
      reason: 'its .git holds a link: HEAD',
      plant: (gitFolder) => {
        rmSync(join(gitFolder, 'HEAD'));
        symlinkSync(join(repository, '.git', 'HEAD'), join(gitFolder, 'HEAD'));
      },
    },
    {
      name: 'a named pipe as its HEAD',
      reason: 'its .git holds a special file: HEAD',
      plant: (gitFolder) => {
        rmSync(join(gitFolder, 'HEAD'));
        expect(spawnSync('mkfifo', [join(gitFolder, 'HEAD')]).status).toBe(0);
      },
    },
    {
      name: 'a link as its .git',
      reason: 'its .git is neither a file nor a folder of its own',
      plant: (gitFolder, worktree) => {
        rmSync(join(worktree, '.git'));
        symlinkSync(join(repository, '.git'), join(worktree, '.git'));
      },
    },
  ];

  it.each(plants)('refuses to read a worktree with $name, saying why', async ({ plant, reason }) => {
    const worktree = join(folder, 'worktree');
    await git(['-C', repository, 'worktree', 'add', '-q', '--detach', worktree]);
    plant(join(repository, '.git', 'worktrees', 'worktree'), worktree);

    await expect(gitInFolder(worktree, ['status', '--porcelain'])).rejects.toEqual(new RefusedRead(worktree, reason));
  });
});
