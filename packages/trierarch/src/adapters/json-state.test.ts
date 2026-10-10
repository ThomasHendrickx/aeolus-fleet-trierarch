import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMPTY_STATE, type TrierarchState } from '../core/entry.js';
import { aTrierarch, crewSettings, newId, WORKTREE_ROOT } from '../../test/support/in-memory.js';
import { createJsonState } from './json-state.js';

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
        settingsVersion: 1,
        state: 'running',
        since: '2026-10-06T08:00:00.000Z',
        exits: [],
        folder: '/home/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/scout',
        hasStarted: true,
        wake: { waiting: 0, isPending: false },
      },
    },
    kept: [],
    orphans: [],
    refused: {},
  };
};

/**
 * A state with every optional field filled, down to the items of its lists:
 * a field added to the state but not to this factory fails the typecheck,
 * and one the state file schema does not know then fails the round trip (#543).
 */
type Populated<T> = T extends readonly (infer Item)[] ? readonly Populated<Item>[] : T extends object ? { readonly [Key in keyof T]-?: Populated<T[Key]> } : T;

const aPopulatedState = (): Populated<TrierarchState> => {
  const shipId = newId('ship');
  return {
    entries: {
      [shipId]: {
        shipId,
        shipName: 'scout',
        settingsVersion: 2,
        harness: 'claude-code',
        workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'main' },
        squadron: 'pathfinders',
        firstPrompt: 'Chart the coast.',
        options: { model: 'opus' },
        state: 'restarting',
        since: '2026-10-06T08:00:00.000Z',
        exits: ['2026-10-06T07:59:00.000Z'],
        restartAt: '2026-10-06T08:01:00.000Z',
        folder: '/home/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/scout',
        hasStarted: true,
        launchedAt: '2026-10-06T07:58:30.000Z',
        isReleasedElsewhere: true,
        wake: { waiting: 2, isPending: true },
      },
    },
    kept: [{ shipId: newId('ship'), repository: 'aeolus-fleet', path: '/home/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/lookout' }],
    orphans: [{ path: '/home/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/stray', repository: 'aeolus-fleet', name: 'stray' }],
    refused: { [newId('ship')]: 3 },
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

  it('loads every field of a state it saved with all of them filled, so a field the state file schema does not know cannot be dropped unseen (#543)', async () => {
    const store = createJsonState(join(folder, 'state.json'));
    const state = aPopulatedState();

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
  });

  it('loads when the session of an entry crewing started, so its launch window survives a restart of the trierarch (#382)', async () => {
    const store = createJsonState(join(folder, 'state.json'));
    const state = aState();
    const entries = Object.fromEntries(Object.entries(state.entries).map(([shipId, entry]) => [shipId, { ...entry, state: 'crewing' as const, launchedAt: '2026-10-06T08:00:30.000Z' }]));
    const crewing = { ...state, entries };

    await store.save(crewing);

    await expect(store.load()).resolves.toEqual(crewing);
  });

  it('loads the mark of an entry released elsewhere, so a retried pass still removes its worktree first (#532)', async () => {
    const store = createJsonState(join(folder, 'state.json'));
    const state = aState();
    const entries = Object.fromEntries(Object.entries(state.entries).map(([shipId, entry]) => [shipId, { ...entry, state: 'crewing' as const, isReleasedElsewhere: true as const }]));
    const releasedElsewhere = { ...state, entries };

    await store.save(releasedElsewhere);

    await expect(store.load()).resolves.toEqual(releasedElsewhere);
  });

  it('crews a ship released elsewhere in a fresh worktree on the pass after a failed remove, its state read back from the state file (#532)', async () => {
    const store = createJsonState(join(folder, 'state.json'));
    const trierarch = aTrierarch();
    const scoutFolder = `${WORKTREE_ROOT}/aeolus-fleet/scout`;
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings({}));
    await trierarch.pass();
    await trierarch.pass();
    trierarch.workspace.change(scoutFolder);
    trierarch.fleet.releaseElsewhere(shipId);
    trierarch.workspace.isFailingRemove = true;
    await trierarch.pass();
    trierarch.workspace.isFailingRemove = false;
    // The trierarch restarts: what it kept is what the state file gives back.
    await store.save(trierarch.state.current());
    await trierarch.state.save(await store.load());

    await trierarch.pass();

    expect(trierarch.workspace.folders.get(scoutFolder)).toMatchObject({ hasChanges: false, unsaved: [] });
  });

  it('loads the kept worktrees and orphans it saved, each with its repository, and an orphan with its name (#325)', async () => {
    const store = createJsonState(join(folder, 'state.json'));
    const state = {
      ...aState(),
      kept: [{ shipId: newId('ship'), repository: 'aeolus-fleet', path: '/home/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/lookout' }],
      orphans: [{ path: '/home/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/stray', repository: 'aeolus-fleet', name: 'stray' }],
    };

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
  });

  it('stops with an error naming the file and what to empty when its kept worktrees or orphans have a shape from before 0.20 (decision 0013)', async () => {
    const path = join(folder, 'state.json');
    writeFileSync(path, JSON.stringify({ ...aState(), kept: [{ shipId: newId('ship'), path: '/home/thomas/scout' }], orphans: ['/home/thomas/stray'] }));

    await expect(createJsonState(path).load()).rejects.toThrow(
      `${path} does not hold the state this trierarch reads: empty its kept and orphans ("kept": [], "orphans": []) and start it again; the next pass finds the orphans again`,
    );
  });

  it('writes the file whole, leaving no temporary file, readable by its user only', async () => {
    const path = join(folder, 'state.json');

    await createJsonState(path).save(aState());

    expect(readdirSync(folder)).toEqual(['state.json']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('moves a 0.17 state file aside and starts empty: its ships are not migrated (decision 0013)', async () => {
    const path = join(folder, 'state.json');
    const old = '{"entries": {}, "applied": {}, "kept": [], "orphans": []}';
    writeFileSync(path, old);

    await expect(createJsonState(path).load()).resolves.toEqual(EMPTY_STATE);

    expect(readdirSync(folder)).toEqual(['state.0.17.json']);
    expect(readFileSync(join(folder, 'state.0.17.json'), 'utf8')).toBe(old);
  });

  it('refuses a state file that does not fit, rather than guessing', async () => {
    const path = join(folder, 'state.json');
    writeFileSync(path, '{"entries": 3}');

    await expect(createJsonState(path).load()).rejects.toThrow();
  });
});
