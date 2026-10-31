import { describe, expect, it } from 'vitest';

import { EMPTY_STATE, type Entry } from '../core/entry.js';
import type { RefreshedCheckout } from '../core/ports.js';
import { InMemoryState, newId } from '../../test/support/in-memory.js';
import { createShipRefresh } from './ship-refresh.js';

const COMPANY_FOLDER = '/home/thomas/.aeolus/trierarch/worktrees/aeolus-company/chief-of-staff';
const SKILLS = { repository: 'skills', revision: '3f2a9c1' } as const;

/** A crewed ship in the company repository. */
function aCompanyEntry(shipId: Entry['shipId']): Entry {
  return { shipId, shipName: 'chief-of-staff', settingsVersion: 1, harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-company', ref: 'main' }, options: {}, state: 'running', since: '2026-10-31T17:00:00.000Z', exits: [], folder: COMPANY_FOLDER, hasStarted: true };
}

async function aStateWith(entry: Entry): Promise<InMemoryState> {
  const state = new InMemoryState();
  await state.save({ ...EMPTY_STATE, entries: { [entry.shipId]: entry } });
  return state;
}

/** The workspace's refresh, answering for the company repository only, as a read-only workspace does. */
const workspace = {
  refresh: ({ repository }: { repository: string; folder: string }): Promise<RefreshedCheckout | undefined> => Promise.resolve(repository === 'aeolus-company' ? { repository, revision: 'b71e0d4' } : undefined),
};
const checkouts = { refresh: (): Promise<readonly RefreshedCheckout[]> => Promise.resolve([SKILLS]) };

describe("a ship's refresh (aeolus-fleet#1449)", () => {
  it('brings its read-only workspace to the latest main first, then its checkouts', async () => {
    const shipId = newId('ship');

    const refreshed = await createShipRefresh({ state: await aStateWith(aCompanyEntry(shipId)), workspace, checkouts })(shipId);

    expect(refreshed).toEqual([{ repository: 'aeolus-company', revision: 'b71e0d4' }, SKILLS]);
  });

  it('brings only its checkouts when its workspace is not read-only', async () => {
    const shipId = newId('ship');
    const entry: Entry = { ...aCompanyEntry(shipId), workspace: { kind: 'worktree', repository: 'aeolus-fleet' } };

    const refreshed = await createShipRefresh({ state: await aStateWith(entry), workspace, checkouts })(shipId);

    expect(refreshed).toEqual([SKILLS]);
  });

  it('brings only its checkouts for a ship in a configured folder', async () => {
    const shipId = newId('ship');
    const entry: Entry = { ...aCompanyEntry(shipId), workspace: { kind: 'folder', name: 'notes' } };

    const refreshed = await createShipRefresh({ state: await aStateWith(entry), workspace, checkouts })(shipId);

    expect(refreshed).toEqual([SKILLS]);
  });

  it('brings only its checkouts for a ship it holds no folder for', async () => {
    const shipId = newId('ship');
    const entry: Entry = { ...aCompanyEntry(shipId), folder: undefined };

    const refreshed = await createShipRefresh({ state: await aStateWith(entry), workspace, checkouts })(shipId);

    expect(refreshed).toEqual([SKILLS]);
  });
});
