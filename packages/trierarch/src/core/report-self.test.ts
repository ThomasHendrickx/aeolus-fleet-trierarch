import { trierarchReportDetailsSchema } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { aTrierarch, newId, WORKTREE_ROOT, type Trierarch } from '../../test/support/in-memory.js';
import { EMPTY_STATE, putEntry, type Entry } from './entry.js';

/** A ship whose request is assigned to the trierarch, crewed, so its session runs. */
async function aRunningShip(trierarch: Trierarch) {
  const shipId = trierarch.fleet.commission('scout');
  trierarch.fleet.request(shipId);
  await trierarch.pass();
  return shipId;
}

/** An entry whose session crashed past its restart budget. */
function aCrashedEntry(): Entry {
  return {
    shipId: newId('ship'),
    harness: 'claude-code',
    workspace: { kind: 'worktree', repository: 'aeolus-fleet' },
    options: {},
    settingsVersion: 1,
    state: 'crashed',
    since: '2026-10-06T22:00:00.000Z',
    exits: [],
    hasStarted: true,
    wake: { waiting: 0, isPending: false },
  };
}

describe("the trierarch's own report (docs/trierarch.md, What a trierarch reports)", () => {
  it('reports on start the details its configuration and saved state hold, as the trierarch report details', async () => {
    const trierarch = aTrierarch();
    const kept = { shipId: newId('ship'), path: `${WORKTREE_ROOT}/aeolus-fleet/lookout` };
    await trierarch.state.save({ ...EMPTY_STATE, kept: [kept], orphans: [`${WORKTREE_ROOT}/aeolus-fleet/stray`] });

    await trierarch.reportSelf();

    const [report] = trierarch.fleet.selfReports;
    expect(report?.details).toEqual({
      harnesses: [
        {
          harness: 'claude-code',
          options: { type: 'object', properties: { model: { enum: ['opus', 'sonnet'], default: 'opus' } }, additionalProperties: false },
          flags: ['--remote-control'],
        },
      ],
      workspaces: { repositories: ['aeolus-fleet'], folders: ['notes'] },
      caps: { ships: 8, running: 4 },
      kept: [kept],
      orphans: [{ path: `${WORKTREE_ROOT}/aeolus-fleet/stray` }],
      version: '0.1.0',
    });
    expect(trierarchReportDetailsSchema.safeParse(report?.details).success).toBe(true);
  });

  it('is idle while no session runs, and says how many run of its cap', async () => {
    const trierarch = aTrierarch();

    await trierarch.reportSelf();

    expect(trierarch.fleet.selfReports.map(({ state, note }) => ({ state, note }))).toEqual([{ state: 'idle', note: '0 of 8 running' }]);
  });

  it('is working while a session runs, and names the crashed ones', async () => {
    const trierarch = aTrierarch();
    await aRunningShip(trierarch);
    await trierarch.state.save(putEntry(trierarch.state.current(), aCrashedEntry()));

    await trierarch.reportSelf();

    expect(trierarch.fleet.selfReports.map(({ state, note }) => ({ state, note }))).toEqual([{ state: 'working', note: '1 of 8 running, 1 crashed' }]);
  });

  it('reports nothing again while nothing changed', async () => {
    const trierarch = aTrierarch();

    await trierarch.reportSelf();
    await trierarch.reportSelf();

    expect(trierarch.fleet.selfReports).toHaveLength(1);
  });

  it('reports again when its details change', async () => {
    const trierarch = aTrierarch();
    await trierarch.reportSelf();

    await trierarch.state.save({ ...EMPTY_STATE, orphans: [`${WORKTREE_ROOT}/aeolus-fleet/stray`] });
    await trierarch.reportSelf();

    expect(trierarch.fleet.selfReports.map((report) => report.details.orphans)).toEqual([[], [{ path: `${WORKTREE_ROOT}/aeolus-fleet/stray` }]]);
  });

  it('reports again when how many run changes', async () => {
    const trierarch = aTrierarch();
    await trierarch.reportSelf();

    await aRunningShip(trierarch);
    await trierarch.reportSelf();

    expect(trierarch.fleet.selfReports.map(({ note }) => note)).toEqual(['0 of 8 running', '1 of 8 running']);
  });
});
