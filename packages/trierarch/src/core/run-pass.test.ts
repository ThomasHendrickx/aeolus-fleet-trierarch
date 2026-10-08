import type { ShipId } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { aTrierarch, CONFIGURATION, crewSettings, NOTES_FOLDER, WORKTREE_ROOT, type Trierarch } from '../../test/support/in-memory.js';
import { RESTART_BUDGET } from './restart-policy.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const SCOUT_FOLDER = `${WORKTREE_ROOT}/aeolus-fleet/scout`;
const WITH_CODEX = { ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } };

/** A ship whose crew request is assigned to the trierarch, crewed by one pass: its id. */
async function aCrewedShip(trierarch: Trierarch, settings: Record<string, unknown> = {}) {
  const shipId = trierarch.fleet.commission('scout');
  trierarch.fleet.request(shipId, crewSettings(settings));
  await trierarch.pass();
  return shipId;
}

/** Lets the session die until the restart budget is spent. */
async function crashForGood(trierarch: Trierarch, shipId: ShipId) {
  for (let exit = 0; exit <= RESTART_BUDGET; exit += 1) {
    trierarch.processes.exit(shipId);
    await trierarch.pass();
    trierarch.clock.advance(10 * MINUTE_MS);
    await trierarch.pass();
  }
}

const statusesOf = (trierarch: Trierarch, shipId: ShipId) => trierarch.fleet.statuses.filter((each) => each.shipId === shipId).map((each) => each.status);

describe('the lifecycle of an assigned crew request (docs/trierarch.md)', () => {
  it('row 3: the first crew registers, makes the worktree, writes the identity and starts the session with the first prompt', async () => {
    const trierarch = aTrierarch();

    const shipId = await aCrewedShip(trierarch, { firstPrompt: 'Review the open pull requests.' });

    expect(trierarch.fleet.shipOf(shipId).status).toBe('crewed');
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(true);
    expect(trierarch.harness.identities.get(SCOUT_FOLDER)).toEqual({
      fleetUrl: 'https://fleet.example.com',
      shipId,
      shipName: 'scout',
      crewToken: trierarch.fleet.shipOf(shipId).crewToken,
    });
    expect(trierarch.harness.launches).toEqual([
      { shipId, shipName: 'scout', folder: SCOUT_FOLDER, workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, isFirstStart: true, firstPrompt: 'Review the open pull requests.' },
    ]);
    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', folder: SCOUT_FOLDER, shipName: 'scout', settingsVersion: 1 });
  });

  it('row 3: writes status crewing, then running', async () => {
    const trierarch = aTrierarch();

    const shipId = await aCrewedShip(trierarch);

    expect(statusesOf(trierarch, shipId)).toEqual(['crewing', 'running']);
  });

  it('row 3: writes no session start while crewing, and when the session started once running, as its first start (#332)', async () => {
    const trierarch = aTrierarch();

    const shipId = await aCrewedShip(trierarch);

    expect(trierarch.fleet.statuses.filter((each) => each.shipId === shipId)).toEqual([
      { shipId, status: 'crewing', attempt: 0, startedAt: null },
      { shipId, status: 'running', attempt: 0, startedAt: trierarch.clock.now() },
    ]);
  });

  it('row 3: saves the entry as crewing before it registers', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId);
    trierarch.fleet.isLosingRegisterReply = true;

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.state).toBe('crewing');
    expect(trierarch.fleet.requestOf(shipId).status).toBe('crewing');
  });

  it('row 3: passes the squadron to the identity, so the member checks in at its flagship', async () => {
    const trierarch = aTrierarch();

    await aCrewedShip(trierarch, { squadron: 'hemma-feature-a1b2c3' });

    expect(trierarch.harness.identities.get(SCOUT_FOLDER)?.squadron).toBe('hemma-feature-a1b2c3');
  });

  it('row 3: crews with the options the settings pick', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings({ options: { model: 'sonnet' } }));

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.options).toEqual({ model: 'sonnet' });
  });

  it('row 4: writes the restart attempt while it restarts, and when the restarted session started (#332)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.exit(shipId);

    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    expect(trierarch.fleet.statuses.filter((each) => each.shipId === shipId).slice(2)).toEqual([
      { shipId, status: 'restarting', attempt: 1, startedAt: null },
      { shipId, status: 'running', attempt: 1, startedAt: trierarch.clock.now() },
    ]);
  });

  it('row 4: a session that dies starts again in the same folder with the same crew token, after its wait', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    const { crewToken } = trierarch.fleet.shipOf(shipId);
    trierarch.processes.exit(shipId);

    await trierarch.pass();
    expect(trierarch.state.current().entries[shipId]?.state).toBe('restarting');
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    expect(trierarch.harness.launches.at(-1)).toEqual({ shipId, shipName: 'scout', folder: SCOUT_FOLDER, workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, isFirstStart: false });
    expect(trierarch.fleet.shipOf(shipId).crewToken).toBe(crewToken);
    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', exits: [expect.any(String)] });
    expect(statusesOf(trierarch, shipId)).toEqual(['crewing', 'running', 'restarting', 'running']);
  });

  it("row 4: reports on the ship's behalf that its session crashed and restarts (gap rule 5)", async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.exit(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.reports).toEqual([{ crewToken: trierarch.fleet.shipOf(shipId).crewToken, state: 'blocked', note: 'blocked: session crashed, restarting' }]);
  });

  it('row 5: once the restart budget is spent the session is stopped, status crashed and a report sent to argo', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);

    await crashForGood(trierarch, shipId);

    expect(trierarch.state.current().entries[shipId]?.state).toBe('crashed');
    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.fleet.requestOf(shipId).status).toBe('crashed');
    expect(trierarch.fleet.shipOf(shipId).status).toBe('crewed');
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([
      `scout (${shipId}): its session crashed ${String(RESTART_BUDGET + 1)} times within an hour, restart budget spent; status crashed. Restart it in the console to crew it again.`,
    ]);
  });

  it('row 6: after the machine restarts the loop starts every assigned ship again, counting no restart', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.restartMachine();

    await trierarch.pass();

    expect(trierarch.processes.sessions.get(shipId)).toBe('running');
    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', exits: [] });
    expect(trierarch.fleet.shipOf(shipId).secret).toBe('aeolus_sk_v1_1');
  });

  it('row 7: a removed request stops the session, ends the lease, removes the clean worktree and confirms', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.fleet.shipOf(shipId).status).toBe('awaitingCrew');
    expect(trierarch.state.current().entries).toEqual({});
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.fleet.confirmed).toEqual([shipId]);
    expect(trierarch.fleet.requests.has(shipId)).toBe(false);
  });

  it('row 7: keeps and reports a worktree with changes, and ends the lease all the same (gap rules 1 and 4)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.shipOf(shipId).status).toBe('awaitingCrew');
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(true);
    expect(trierarch.harness.identities.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.state.current().kept).toEqual([{ shipId, repository: 'aeolus-fleet', path: SCOUT_FOLDER }]);
    expect(trierarch.fleet.confirmed).toEqual([shipId]);
  });

  it('drops a kept worktree once it is gone from disk, as when a human removed it by hand (#325)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.removeRequest(shipId);
    await trierarch.pass();
    trierarch.workspace.folders.delete(SCOUT_FOLDER);

    await trierarch.pass();

    expect(trierarch.state.current().kept).toEqual([]);
    expect(trierarch.state.current().orphans).toEqual([]);
  });

  it('keeps a kept worktree that is still on disk, pass after pass', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.removeRequest(shipId);
    await trierarch.pass();

    await trierarch.pass();

    expect(trierarch.state.current().kept).toEqual([{ shipId, repository: 'aeolus-fleet', path: SCOUT_FOLDER }]);
  });

  it('clears a kept worktree its clear request names: removes it, drops it from kept and confirms it removed (decision 0032)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.removeRequest(shipId);
    await trierarch.pass();
    trierarch.fleet.clearWorktree({ shipId, repository: 'aeolus-fleet' });

    await trierarch.pass();

    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.state.current().kept).toEqual([]);
    expect(trierarch.fleet.clearRequests).toEqual([]);
    expect(trierarch.fleet.cleared).toEqual([{ shipId, repository: 'aeolus-fleet', outcome: 'removed' }]);
  });

  it('confirms a clear request for a worktree it does not keep as not-kept, and removes nothing (decision 0032)', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.workspace.folders.set(SCOUT_FOLDER, { hasChanges: true });
    trierarch.fleet.clearWorktree({ shipId, repository: 'aeolus-fleet' });

    await trierarch.pass();

    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(true);
    expect(trierarch.fleet.cleared).toEqual([{ shipId, repository: 'aeolus-fleet', outcome: 'not-kept' }]);
  });

  it('keeps a kept worktree and its clear request when removing it fails, so the next pass tries again', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.removeRequest(shipId);
    await trierarch.pass();
    trierarch.fleet.clearWorktree({ shipId, repository: 'aeolus-fleet' });
    trierarch.workspace.isFailingRemove = true;

    await trierarch.pass();

    expect(trierarch.state.current().kept).toEqual([{ shipId, repository: 'aeolus-fleet', path: SCOUT_FOLDER }]);
    expect(trierarch.fleet.clearRequests).toHaveLength(1);
    expect(trierarch.fleet.cleared).toEqual([]);
  });

  it('row 7: a configured folder is never removed, only its identity', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch, { workspace: { kind: 'folder', name: 'notes' } });
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    expect(trierarch.workspace.folders.has(NOTES_FOLDER)).toBe(true);
    expect(trierarch.harness.identities.has(NOTES_FOLDER)).toBe(false);
    expect(trierarch.state.current().kept).toEqual([]);
  });

  it('row 7: a removed request it never crewed is confirmed at once', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId);
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.confirmed).toEqual([shipId]);
    expect(trierarch.harness.launches).toEqual([]);
  });

  it('row 8: after a lost register reply, the trierarch releases the ship and crews it again (gap rule 3)', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId);
    trierarch.fleet.isLosingRegisterReply = true;
    await trierarch.pass();
    const lostToken = trierarch.fleet.shipOf(shipId).crewToken;

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.state).toBe('running');
    expect(trierarch.fleet.shipOf(shipId).crewToken).not.toBe(lostToken);
    expect(trierarch.harness.identities.get(SCOUT_FOLDER)?.crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
  });

  it('row 8: a half-made worktree of an assigned ship is used when the crew resumes', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId);
    trierarch.workspace.folders.set(SCOUT_FOLDER, { shipId, hasChanges: false });

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.folder).toBe(SCOUT_FOLDER);
    expect(trierarch.state.current().orphans).toEqual([]);
  });

  it('row 11: a ship released elsewhere has its session stopped and is crewed again in the same folder', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    const firstToken = trierarch.fleet.shipOf(shipId).crewToken;
    trierarch.fleet.releaseElsewhere(shipId);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.shipOf(shipId).status).toBe('crewed');
    expect(trierarch.fleet.shipOf(shipId).crewToken).not.toBe(firstToken);
    expect(trierarch.harness.identities.get(SCOUT_FOLDER)?.crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
    expect(trierarch.harness.launches.map((launch) => launch.folder)).toEqual([SCOUT_FOLDER, SCOUT_FOLDER]);
    expect(trierarch.state.current().entries[shipId]?.state).toBe('running');
  });

  it('row 12: a new settings version stops the session and crews it again with that version, keeping the worktree', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.requestAgain(shipId, crewSettings({ options: { model: 'sonnet' } }));

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', settingsVersion: 2, options: { model: 'sonnet' }, folder: SCOUT_FOLDER });
    expect(trierarch.harness.launches).toHaveLength(2);
    expect(trierarch.workspace.folders.get(SCOUT_FOLDER)?.hasChanges).toBe(true);
    expect(trierarch.fleet.shipOf(shipId).status).toBe('crewed');
    expect(trierarch.harness.identities.get(SCOUT_FOLDER)?.crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
  });

  it('row 12: a crashed request written again starts again with a fresh restart budget', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    await crashForGood(trierarch, shipId);

    trierarch.fleet.requestAgain(shipId);
    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', exits: [], folder: SCOUT_FOLDER });
    expect(trierarch.processes.sessions.get(shipId)).toBe('running');
    expect(trierarch.fleet.requestOf(shipId).status).toBe('running');
  });
});

describe('the gaps the loop closes (docs/trierarch.md)', () => {
  it('rule 2: a session of the trierarch with no assigned request is stopped', async () => {
    const trierarch = aTrierarch();
    const stray = trierarch.fleet.commission('stray');
    trierarch.processes.sessions.set(stray, 'running');

    await trierarch.pass();

    expect(trierarch.processes.sessions.has(stray)).toBe(false);
  });

  it('rule 2: a worktree under its root with no assigned request is reported as an orphan, never deleted', async () => {
    const trierarch = aTrierarch();
    const orphan = `${WORKTREE_ROOT}/aeolus-fleet/lookout`;
    trierarch.workspace.folders.set(orphan, { hasChanges: false });

    await trierarch.pass();

    expect(trierarch.workspace.folders.has(orphan)).toBe(true);
    expect(trierarch.state.current().orphans).toEqual([{ path: orphan, repository: 'aeolus-fleet', name: 'lookout' }]);
  });

  it('rule 2: a request no longer assigned to it, as when its ship is retired, has its session stopped and its worktree left as an orphan', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.unassign(shipId);

    await trierarch.pass();

    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.state.current().entries).toEqual({});
    expect(trierarch.harness.identities.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(true);
    expect(trierarch.state.current().orphans).toEqual([{ path: SCOUT_FOLDER, repository: 'aeolus-fleet', name: 'scout' }]);
  });

  it('rule 5: an inbox is watched only while its session runs', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.exit(shipId);
    trierarch.fleet.releaseElsewhere(shipId);

    await trierarch.pass();

    // The lease ended while the session was down: unseen until its session runs again.
    expect(trierarch.state.current().entries[shipId]?.state).toBe('restarting');
  });

  it('leaves a ship crewed by hand before its first crew, writes no status, and crews it once it awaits crew again', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId);
    trierarch.fleet.crewElsewhere(shipId);

    await trierarch.pass();
    expect(trierarch.fleet.shipOf(shipId).crewToken).toBe('aeolus_ct_v1_elsewhere');
    expect(trierarch.fleet.statuses).toEqual([]);
    expect(trierarch.state.current().entries).toEqual({});

    trierarch.fleet.releaseElsewhere(shipId);
    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.state).toBe('running');
  });

  it.each([
    { label: 'a harness it does not offer', settings: crewSettings({ harness: 'codex' }), reason: 'harness: This trierarch offers no harness codex' },
    { label: 'a repository it does not offer', settings: crewSettings({ workspace: { kind: 'worktree', repository: 'hemma' } }), reason: 'workspace.repository: This trierarch offers no repository hemma' },
    { label: 'an option value it does not offer', settings: crewSettings({ options: { model: 'haiku' } }), reason: 'options.model: model must be one of opus, sonnet' },
    { label: 'settings that are not crew settings', settings: { harness: 'claude-code' }, reason: 'workspace: Invalid input: expected object, received undefined' },
  ])('does not crew settings with $label, and tells argo once per version', async ({ settings, reason }) => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, settings);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.harness.launches).toEqual([]);
    expect(trierarch.fleet.statuses).toEqual([]);
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([`scout (${shipId}): this trierarch cannot crew settings version 1: ${reason}`]);
  });

  it('wakes an idle session once when deliveries come, and not again until it has received', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 1);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.harness.wakes).toEqual([shipId]);
  });

  it('wakes a busy session once it turns idle', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'busy');
    trierarch.fleet.deliver(shipId, 1);
    await trierarch.pass();
    expect(trierarch.harness.wakes).toEqual([]);

    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    await trierarch.pass();

    expect(trierarch.harness.wakes).toEqual([shipId]);
  });

  it('starts no more sessions than its running cap', async () => {
    const trierarch = aTrierarch({ ...CONFIGURATION, caps: { ships: 3, running: 1 } });
    const first = trierarch.fleet.commission('first');
    const second = trierarch.fleet.commission('second');
    trierarch.fleet.request(first);
    trierarch.fleet.request(second);

    await trierarch.pass();

    expect(trierarch.processes.sessions.size).toBe(1);
    expect(Object.keys(trierarch.state.current().entries)).toEqual([first]);
  });

  it('crews a ship with the harness its settings name: its identity and its session', async () => {
    const trierarch = aTrierarch(WITH_CODEX);

    await aCrewedShip(trierarch, { harness: 'codex' });

    expect(trierarch.codex.identities.has(SCOUT_FOLDER)).toBe(true);
    expect(trierarch.codex.launches).toHaveLength(1);
    expect(trierarch.harness.launches).toEqual([]);
  });

  it("wakes a ship through the harness its settings name, from that harness's turn", async () => {
    const trierarch = aTrierarch(WITH_CODEX);
    const shipId = await aCrewedShip(trierarch, { harness: 'codex' });
    trierarch.codex.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 1);

    await trierarch.pass();

    expect(trierarch.codex.wakes).toEqual([shipId]);
  });
});

describe('what the loop logs (aeolus-trierarch logs)', () => {
  const logged = (trierarch: Trierarch) => trierarch.logger.actions.map(({ action, outcome }) => `${action}: ${outcome}`);

  it('logs a crew with its time, its ship and the outcome', async () => {
    const trierarch = aTrierarch();

    const shipId = await aCrewedShip(trierarch);

    expect(trierarch.logger.actions).toEqual([{ time: trierarch.clock.now(), shipId, shipName: 'scout', action: 'crew', outcome: `crewed, claude-code started in ${SCOUT_FOLDER}` }]);
  });

  it('logs the report on its behalf when its session died, and its start again', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.exit(shipId);

    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    expect(logged(trierarch).slice(1)).toEqual(['report: reported blocked: session crashed, restarting', `launch: started again in ${SCOUT_FOLDER}`]);
  });

  it('logs a wake', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 1);

    await trierarch.pass();

    expect(logged(trierarch).at(-1)).toBe('wake: woken, deliveries wait');
  });

  it('logs a release, saying whether its worktree was removed or kept', async () => {
    const clean = aTrierarch();
    clean.fleet.removeRequest(await aCrewedShip(clean));
    const changed = aTrierarch();
    const shipId = await aCrewedShip(changed);
    changed.workspace.change(SCOUT_FOLDER);
    changed.fleet.removeRequest(shipId);

    await clean.pass();
    await changed.pass();

    expect(logged(clean).at(-1)).toBe('release: released, its worktree removed');
    expect(logged(changed).at(-1)).toBe(`release: released, its worktree kept with changes: ${SCOUT_FOLDER}`);
  });

  it('logs a clear, saying whether it removed the kept worktree or kept none', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.removeRequest(shipId);
    await trierarch.pass();
    trierarch.fleet.clearWorktree({ shipId, repository: 'aeolus-fleet' });
    await trierarch.pass();
    trierarch.fleet.clearWorktree({ shipId, repository: 'aeolus-fleet' });

    await trierarch.pass();

    expect(logged(trierarch).slice(-2)).toEqual([`clear: its kept worktree removed: ${SCOUT_FOLDER}`, 'clear: no kept aeolus-fleet worktree of it here']);
  });

  it('logs a ship it leaves because another session crews it', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId);
    trierarch.fleet.crewElsewhere(shipId);

    await trierarch.pass();

    expect(logged(trierarch)).toEqual(['leave: crewed by another session, so the trierarch leaves it']);
  });

  it('logs a failure with its ship and what happens next, and ends the pass there', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId);
    trierarch.fleet.isLosingRegisterReply = true;

    await trierarch.pass();

    expect(trierarch.logger.actions).toEqual([
      {
        time: trierarch.clock.now(),
        shipId,
        action: 'crew',
        outcome: 'failed: the register reply was lost',
        next: 'the next pass tries again; aeolus-trierarch status and list show where it stands',
      },
    ]);
  });
});
