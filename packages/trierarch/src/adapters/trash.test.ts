import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeUnremovable, removeAsRuntime, unremovableReason } from '../../test/support/unremovable.js';
import { createTrash, discard } from './trash.js';

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

      expect(first).toEqual([{ path: expect.stringContaining(trashOf(folder)) as string, folder, trashedAt: DISCARDED_AT, isNew: true, isTold: false, why: expect.any(String) as string }]);
      expect(second).toEqual([{ ...first[0], isNew: false }]);
      expect(existsSync(first[0]?.path ?? '')).toBe(true);
    });
  });

  it.skipIf(unremovableReason !== undefined)('keeps what was left and told as told, and tries it again', async () => {
    makeUnremovable(folder);
    await discard(folder, DISCARDED_AT);
    const trash = besideTheFolder();
    const [left] = await trash.empty();

    await trash.markTold(left?.path ?? '');
    const again = await trash.empty();

    expect(again).toEqual([{ path: expect.stringContaining(trashOf(folder)) as string, folder, trashedAt: DISCARDED_AT, isNew: false, isTold: true, why: expect.any(String) as string }]);
    await expect(besideTheFolder(removeAsRuntime).empty()).resolves.toEqual([]);
  });

  it('leaves nothing where there is no trash', async () => {
    await expect(besideTheFolder().empty()).resolves.toEqual([]);
  });
});
