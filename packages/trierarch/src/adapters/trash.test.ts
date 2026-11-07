import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LeftInTrash } from '../core/ports.js';
import { makeUnmovable, makeUnremovable, moveAsRuntime, removeAsRuntime, unremovableReason } from '../../test/support/unremovable.js';
import { createTrash, discard, moveWithinUserNamespace, removeWithinUserNamespace } from './trash.js';

// Against the real file system, in a temporary folder.

const DISCARDED_AT = new Date('2026-11-07T09:30:00.000Z');

let root: string;
/** `<root>/aeolus-fleet/scout` with a file in it, as a ship's clone stands. */
let folder: string;

const trashOf = (at: string): string => join(dirname(at), '.trash');
const besideTheFolder = (unshare?: (path: string) => Promise<void>) => createTrash({ beside: () => Promise.resolve([dirname(folder)]), ...(unshare !== undefined && { unshare }) });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trierarch-trash-'));
  folder = join(root, 'aeolus-fleet', 'scout');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'README.md'), 'scout\n');
});

afterEach(async () => {
  // So the test's own folders can go whatever the outcome.
  spawnSync('chmod', ['-R', 'u+rwx', root]);
  if (unremovableReason === undefined) {
    await removeAsRuntime(root);
  }
  rmSync(root, { recursive: true, force: true });
});

describe('the trash beside a released folder', () => {
  it('takes the folder out of its place at once', async () => {
    await discard(folder, DISCARDED_AT);

    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(trashOf(folder))).toHaveLength(1);
  });

  it('keeps a folder discarded twice under one name as two', async () => {
    await discard(folder, DISCARDED_AT);
    mkdirSync(folder);

    await discard(folder, new Date(DISCARDED_AT.getTime() + 1));

    expect(readdirSync(trashOf(folder))).toHaveLength(2);
  });

  it('takes the folder out of its place when its session made its own top read-only', async () => {
    chmodSync(folder, 0o555);

    await discard(folder, DISCARDED_AT);

    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(trashOf(folder))).toHaveLength(1);
  });

  it('refuses a link, and changes nothing it points at', async () => {
    chmodSync(folder, 0o555);
    const link = join(root, 'aeolus-fleet', 'lookout');
    symlinkSync(folder, link);

    await expect(discard(link, DISCARDED_AT, () => Promise.resolve())).rejects.toThrow('no folder');

    expect({ link: existsSync(link), mode: statSync(folder).mode & 0o777 }).toEqual({ link: true, mode: 0o555 });
  });

  it.skipIf(unremovableReason !== undefined)('moves a folder the host cannot move within the runtime\'s user namespace', async () => {
    makeUnmovable(folder);

    await discard(folder, DISCARDED_AT, moveAsRuntime);

    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(trashOf(folder))).toHaveLength(1);
  });

  describe.skipIf(unremovableReason !== undefined).each([
    { runtime: 'on the host', move: undefined },
    { runtime: 'in containers', move: () => Promise.reject(new Error('unshare refused')) },
  ])('a folder neither the host nor the runtime can move $runtime', ({ move }) => {
    it('stays in its place', async () => {
      makeUnmovable(folder);

      await expect(discard(folder, DISCARDED_AT, move)).rejects.toThrow();

      expect(existsSync(folder)).toBe(true);
    });
  });

  it('removes what it holds when emptied, a folder made read-only included', async () => {
    const readOnly = join(folder, 'a', 'b');
    mkdirSync(readOnly, { recursive: true });
    writeFileSync(join(readOnly, 'f'), 'f\n');
    chmodSync(readOnly, 0o500);
    await discard(folder, DISCARDED_AT);

    await expect(besideTheFolder().empty()).resolves.toEqual([]);
    expect(readdirSync(trashOf(folder))).toEqual([]);
  });

  it.skipIf(unremovableReason !== undefined)('removes what the host cannot remove within the runtime\'s user namespace', async () => {
    makeUnremovable(folder);
    await discard(folder, DISCARDED_AT);

    await expect(besideTheFolder(removeAsRuntime).empty()).resolves.toEqual([]);
    expect(readdirSync(trashOf(folder))).toEqual([]);
  });

  describe.skipIf(unremovableReason !== undefined).each([
    { runtime: 'on the host', unshare: undefined },
    { runtime: 'in containers', unshare: () => Promise.reject(new Error('unshare refused')) },
  ])('what cannot be removed $runtime', ({ unshare }) => {
    it('stays in the trash, new only the first time', async () => {
      makeUnremovable(folder);
      await discard(folder, DISCARDED_AT);
      const trash = besideTheFolder(unshare);

      const first = await trash.empty();
      const second = await trash.empty();

      const leftOf = (each: LeftInTrash) => ({ isInTrash: each.path.startsWith(trashOf(folder)), folder: each.folder, trashedAt: each.trashedAt, isNew: each.isNew, isTold: each.isTold, hasWhy: each.why !== '' });
      expect(first.map(leftOf)).toEqual([{ isInTrash: true, folder, trashedAt: DISCARDED_AT, isNew: true, isTold: false, hasWhy: true }]);
      expect(second.map(leftOf)).toEqual([{ isInTrash: true, folder, trashedAt: DISCARDED_AT, isNew: false, isTold: false, hasWhy: true }]);
      expect(second[0]?.path).toBe(first[0]?.path);
      expect(existsSync(first[0]?.path ?? '')).toBe(true);
      // Where it was put in the trash, before any state suffix.
      const put = createHash('sha256').update(join(trashOf(folder), 'scout.1794043800000')).digest('hex');
      expect([first[0]?.pathHash, second[0]?.pathHash]).toEqual([put, put]);
    });
  });

  it.skipIf(unremovableReason !== undefined)('keeps what was left and told as told, and tries it again', async () => {
    makeUnremovable(folder);
    await discard(folder, DISCARDED_AT);
    const trash = besideTheFolder();
    const [left] = await trash.empty();

    await trash.markTold(left?.path ?? '');
    const again = await trash.empty();

    expect(again.map((each) => ({ folder: each.folder, trashedAt: each.trashedAt, isNew: each.isNew, isTold: each.isTold }))).toEqual([{ folder, trashedAt: DISCARDED_AT, isNew: false, isTold: true }]);
    await expect(besideTheFolder(removeAsRuntime).empty()).resolves.toEqual([]);
  });

  it('leaves nothing where there is no trash', async () => {
    await expect(besideTheFolder().empty()).resolves.toEqual([]);
  });
});

describe('the runtime\'s user namespace', () => {
  /** The minute each call within it may run. */
  const TIME_LIMIT_MS = 60_000;
  const aRuntime = (status: (args: readonly string[]) => number = () => 0) => {
    const ran: { command: string; args: readonly string[]; timeoutMs?: number }[] = [];
    const run = (command: string, options: { args: readonly string[]; timeoutMs?: number }) => {
      ran.push({ command, ...options });
      return Promise.resolve({ status: status(options.args), stdout: '', stderr: 'refused' });
    };
    return { ran, run };
  };

  it('removes the path with the runtime\'s unshare rm, within its time limit', async () => {
    const { ran, run } = aRuntime();

    await removeWithinUserNamespace('podman', run)('/worktrees/aeolus-fleet/.trash/scout.1');

    expect(ran).toEqual([{ command: 'podman', args: ['unshare', 'rm', '-rf', '--', '/worktrees/aeolus-fleet/.trash/scout.1'], timeoutMs: TIME_LIMIT_MS }]);
  });

  it('moves a folder, its own write given first, each within its time limit', async () => {
    const { ran, run } = aRuntime();

    await moveWithinUserNamespace('podman', run)('/worktrees/aeolus-fleet/scout', '/worktrees/aeolus-fleet/.trash/scout.1');

    expect(ran).toEqual([
      { command: 'podman', args: ['unshare', 'chmod', 'u+rwx', '--', '/worktrees/aeolus-fleet/scout'], timeoutMs: TIME_LIMIT_MS },
      { command: 'podman', args: ['unshare', 'mv', '-T', '--', '/worktrees/aeolus-fleet/scout', '/worktrees/aeolus-fleet/.trash/scout.1'], timeoutMs: TIME_LIMIT_MS },
    ]);
  });

  it('does not move a folder whose own write it could not give', async () => {
    const { ran, run } = aRuntime((args) => (args[1] === 'chmod' ? 1 : 0));

    await expect(moveWithinUserNamespace('podman', run)('/worktrees/aeolus-fleet/scout', '/worktrees/aeolus-fleet/.trash/scout.1')).rejects.toThrow('podman unshare chmod failed: refused');

    expect(ran.map((each) => each.args[1])).toEqual(['chmod']);
  });

  it('fails a call that ran past its time limit', async () => {
    const run = () => Promise.resolve({ status: 143, stdout: '', stderr: '', isTimedOut: true });

    await expect(removeWithinUserNamespace('podman', run)('/worktrees/aeolus-fleet/.trash/scout.1')).rejects.toThrow('did not end within');
  });
});
