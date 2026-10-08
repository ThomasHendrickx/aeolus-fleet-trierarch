import { trierarchReportDetailsSchema } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { aTrierarch, CONFIGURATION, newId, WORKTREE_ROOT, type Trierarch } from '../../test/support/in-memory.js';
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
    const kept = { shipId: newId('ship'), repository: 'aeolus-fleet', path: `${WORKTREE_ROOT}/aeolus-fleet/lookout` };
    await trierarch.state.save({ ...EMPTY_STATE, kept: [kept], orphans: [{ path: `${WORKTREE_ROOT}/aeolus-fleet/stray`, repository: 'aeolus-fleet', name: 'stray' }] });

    await trierarch.reportSelf();

    const [report] = trierarch.fleet.selfReports;
    expect(report?.details).toEqual({
      harnesses: [
        {
          harness: 'claude-code',
          options: { type: 'object', properties: { model: { enum: ['opus', 'sonnet'], default: 'opus' } }, additionalProperties: false },
          flags: ['--remote-control'],
          riskyFlags: [],
        },
      ],
      workspaces: { repositories: ['aeolus-fleet'], folders: ['notes'] },
      caps: { ships: 8, running: 4 },
      // Paths stay on the machine: a kept worktree goes by its ship and repository, an orphan by its repository and name (#325).
      kept: [{ shipId: kept.shipId, repository: 'aeolus-fleet' }],
      orphans: [{ repository: 'aeolus-fleet', name: 'stray' }],
      machine: { os: 'macos', arch: 'arm64' },
      version: '0.1.0',
    });
    expect(trierarchReportDetailsSchema.safeParse(report?.details).success).toBe(true);
  });

  it('reports per harness the version detected and when its models were last confirmed, and neither for a harness not detected (#365)', async () => {
    const at = new Date('2026-10-08T15:00:00.000Z');
    const trierarch = aTrierarch({ ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } }, {
      'claude-code': { version: '2.1.293', detectedAt: at, confirmedAt: at, options: {} },
    });

    await trierarch.reportSelf();

    const [report] = trierarch.fleet.selfReports;
    expect(report?.details.harnesses.map(({ harness, version, modelsConfirmedAt }) => ({ harness, version, modelsConfirmedAt }))).toEqual([
      { harness: 'claude-code', version: '2.1.293', modelsConfirmedAt: '2026-10-08T15:00:00.000Z' },
      { harness: 'codex', version: undefined, modelsConfirmedAt: undefined },
    ]);
  });

  it("marks each of a harness's flags its adapter calls risky (#326)", async () => {
    const claudeCode = { ...CONFIGURATION.harnesses['claude-code'], flags: ['--remote-control', '--dangerously-skip-permissions'], options: {} };
    const trierarch = aTrierarch({ ...CONFIGURATION, harnesses: { 'claude-code': claudeCode, codex: { flags: ['--dangerously-bypass-approvals-and-sandbox', '--search'], options: {} } } });

    await trierarch.reportSelf();

    const [report] = trierarch.fleet.selfReports;
    expect(report?.details.harnesses.map(({ harness, flags, riskyFlags }) => ({ harness, flags, riskyFlags }))).toEqual([
      { harness: 'claude-code', flags: ['--remote-control', '--dangerously-skip-permissions'], riskyFlags: ['--dangerously-skip-permissions'] },
      { harness: 'codex', flags: ['--dangerously-bypass-approvals-and-sandbox', '--search'], riskyFlags: ['--dangerously-bypass-approvals-and-sandbox'] },
    ]);
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

    await trierarch.state.save({ ...EMPTY_STATE, orphans: [{ path: `${WORKTREE_ROOT}/aeolus-fleet/stray`, repository: 'aeolus-fleet', name: 'stray' }] });
    await trierarch.reportSelf();

    expect(trierarch.fleet.selfReports.map((report) => report.details.orphans)).toEqual([[], [{ repository: 'aeolus-fleet', name: 'stray' }]]);
  });

  it('reports again when how many run changes', async () => {
    const trierarch = aTrierarch();
    await trierarch.reportSelf();

    await aRunningShip(trierarch);
    await trierarch.reportSelf();

    expect(trierarch.fleet.selfReports.map(({ note }) => note)).toEqual(['0 of 8 running', '1 of 8 running']);
  });

  it('offers only the repositories and folders every configured harness trusts (#381)', async () => {
    const trierarch = aTrierarch({ ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } });
    trierarch.trust.untrust('codex', { kind: 'folder', name: 'notes' });

    await trierarch.reportSelf();

    expect(trierarch.fleet.selfReports.at(-1)?.details.workspaces).toEqual({ repositories: ['aeolus-fleet'], folders: [] });
  });

  it('reports again once a place is trusted or no longer trusted (#381)', async () => {
    const trierarch = aTrierarch();
    await trierarch.reportSelf();
    trierarch.trust.untrust('claude-code', { kind: 'repository', name: 'aeolus-fleet' });

    await trierarch.reportSelf();

    expect(trierarch.fleet.selfReports.map((report) => report.details.workspaces.repositories)).toEqual([['aeolus-fleet'], []]);
  });
});
