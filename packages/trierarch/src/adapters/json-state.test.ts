import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMPTY_STATE, type TrierarchState } from '../core/entry.js';
import { newId } from '../../test/support/in-memory.js';
import { APPLIED_CAP, createJsonState } from './json-state.js';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-state-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const aState = (): TrierarchState => {
  const shipId = newId('ship');
  return {
    entries: {
      [shipId]: {
        shipId,
        shipName: 'scout',
        harness: 'claude-code',
        workspace: { kind: 'worktree', repository: 'aeolus-fleet' },
        options: { model: 'opus' },
        requester: newId('ship'),
        state: 'running',
        since: '2026-10-06T08:00:00.000Z',
        exits: [],
        folder: '/home/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/scout',
        hasStarted: true,
        wake: { waiting: 0, isPending: false },
      },
    },
    applied: {},
    kept: [],
    orphans: [],
  };
};

describe('the JSON state store', () => {
  it('starts empty when there is no state file yet', async () => {
    await expect(createJsonState(join(folder, 'state.json')).load()).resolves.toEqual(EMPTY_STATE);
  });

  it('loads what it saved', async () => {
    const store = createJsonState(join(folder, 'nested', 'state.json'));
    const state = aState();

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
  });

  it('writes the file whole, leaving no temporary file, readable by its user only', async () => {
    const path = join(folder, 'state.json');

    await createJsonState(path).save(aState());

    expect(readdirSync(folder)).toEqual(['state.json']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps only the most recent applied messages', async () => {
    const store = createJsonState(join(folder, 'state.json'));
    const applied = Object.fromEntries(Array.from({ length: APPLIED_CAP + 5 }, (_, index) => [`msg_${String(index).padStart(5, '0')}`, []]));

    await store.save({ ...EMPTY_STATE, applied });

    const kept = Object.keys((await store.load()).applied);
    expect(kept).toHaveLength(APPLIED_CAP);
    expect(kept[0]).toBe('msg_00005');
    expect(kept.at(-1)).toBe(`msg_${String(APPLIED_CAP + 4).padStart(5, '0')}`);
  });

  it('refuses a state file that does not fit, rather than guessing', async () => {
    const path = join(folder, 'state.json');
    writeFileSync(path, '{"entries": 3}');

    await expect(createJsonState(path).load()).rejects.toThrow();
  });
});
