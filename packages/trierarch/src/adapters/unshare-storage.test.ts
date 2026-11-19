import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir as systemTemporaryDirectory } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { aShortHome } from '../../test/support/short-home.js';

import { moveWithinIsolatedUserNamespace, removeWithinIsolatedUserNamespace } from './trash.js';

it('isolates every Podman unshare call from the user runtime', async () => {
  const root = await mkdtemp(join(systemTemporaryDirectory(), 'unshare-storage-'));
  const runtime = aShortHome('unshare-runtime');
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime;
  const trash = join(root, '.trash');
  await mkdir(trash);
  const calls: string[][] = [];
  const run = (_binary: string, options: { args: readonly string[] }) => {
    calls.push([...options.args]);
    return Promise.resolve({ status: 0, stdout: '', stderr: '' });
  };
  try {
    await moveWithinIsolatedUserNamespace('podman', run)(join(root, 'ship'), join(trash, 'ship.1'));
    await removeWithinIsolatedUserNamespace('podman', run)(join(trash, 'ship.1'));
    expect(calls).toHaveLength(3);
    for (const args of calls) {
      const rootPath = args[args.indexOf('--root') + 1] ?? '';
      const runroot = args[args.indexOf('--runroot') + 1] ?? '';
      const temporaryDirectory = args[args.indexOf('--tmpdir') + 1] ?? '';
      expect(rootPath.startsWith(`${trash}/`)).toBe(true);
      expect(runroot.startsWith(`${runtime}/aeolus/`)).toBe(true);
      expect(temporaryDirectory.startsWith(`${runtime}/aeolus/`)).toBe(true);
      expect(args).toContain('unshare');
    }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'XDG_RUNTIME_DIR');
    else process.env.XDG_RUNTIME_DIR = previous;
    await rm(runtime, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
