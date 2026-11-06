import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitInFolder } from './git-in-folder.js';
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
