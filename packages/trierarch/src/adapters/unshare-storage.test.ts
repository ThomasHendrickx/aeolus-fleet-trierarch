import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { moveWithinUserNamespace, removeWithinUserNamespace } from './trash.js';

it('isolates every Podman unshare call from the user runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unshare-storage-'));
  const trash = join(root, '.trash');
  await mkdir(trash);
  const calls: string[][] = [];
  const run = (_binary: string, options: { args: readonly string[] }) => {
    calls.push([...options.args]);
    return Promise.resolve({ status: 0, stdout: '', stderr: '' });
  };
  try {
    await moveWithinUserNamespace('podman', run, { isIsolated: true })(join(root, 'ship'), join(trash, 'ship.1'));
    await removeWithinUserNamespace('podman', run, { isIsolated: true })(join(trash, 'ship.1'));
    expect(calls).toHaveLength(3);
    for (const args of calls) {
      const rootPath = args[args.indexOf('--root') + 1] ?? '';
      const runroot = args[args.indexOf('--runroot') + 1] ?? '';
      const tmp = args[args.indexOf('--tmpdir') + 1] ?? '';
      expect(rootPath.startsWith(`${trash}/`)).toBe(true);
      expect(runroot.startsWith(`${trash}/`)).toBe(true);
      expect(tmp.startsWith(`${trash}/`)).toBe(true);
      expect(args).toContain('unshare');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
