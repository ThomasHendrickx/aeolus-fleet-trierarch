import type { ShipId } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { aTrierarch, CONFIGURATION, crewSettings, NOTES_FOLDER, WORKTREE_ROOT, type Trierarch } from '../../test/support/in-memory.js';
import type { LaunchSeen } from './ports.js';
import { RESTART_BUDGET } from './restart-policy.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const SCOUT_FOLDER = `${WORKTREE_ROOT}/aeolus-fleet/scout`;
const WITH_CODEX = { ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } };
const SKIP = '--dangerously-skip-permissions';
/** Claude Code skipping permissions, as the operator configured it, or as an option the settings may pick. */
const SKIPPING = { ...CONFIGURATION, harnesses: { 'claude-code': { flags: [SKIP], options: {} } } };
const SKIPPING_AS_OPTION = { ...CONFIGURATION, harnesses: { 'claude-code': { flags: [], options: { permissions: { values: { ask: [], skip: [SKIP] }, default: 'ask' } } } } };
const UNACCEPTED = `harness: claude-code still asks to accept ${SKIP}: accept it with aeolus-trierarch init`;

/** A ship whose crew request is assigned to the trierarch, crewed by one pass and running from the next, once its session shows activity: its id. */
async function aCrewedShip(trierarch: Trierarch, settings: Record<string, unknown> = {}) {
  const shipId = trierarch.fleet.commission('scout');
  trierarch.fleet.request(shipId, crewSettings(settings));
  await trierarch.pass();
  await trierarch.pass();
  return shipId;
}

/** A ship crewed by one pass, whose session shows what is given in its launch window: its id. */
async function aLaunchedShip(trierarch: Trierarch, at: { seen: LaunchSeen; settings?: Record<string, unknown> }) {
  const shipId = trierarch.fleet.commission('scout');
  trierarch.harness.seen.set(shipId, at.seen);
  trierarch.fleet.request(shipId, crewSettings(at.settings ?? {}));
  await trierarch.pass();
  return shipId;
}

/** Claude Code as detection found it on the machine. */
const DETECTED = { 'claude-code': { version: '2.1.295', detectedAt: new Date('2026-10-09T08:00:00Z'), confirmedAt: null, options: {} } };

/** Lets the session die until the restart budget is spent. */
async function crashForGood(trierarch: Trierarch, shipId: ShipId) {
  for (let exit = 0; exit <= RESTART_BUDGET; exit += 1) {
    trierarch.processes.exit(shipId);
    await trierarch.pass();
    trierarch.clock.advance(10 * MINUTE_MS);
    await trierarch.pass();
  }
}

/**
 * A ship whose crew is given back before it is final, with changes in its
 * worktree, so the trierarch keeps the worktree: its id. Its launch fails, so
 * its crew stays not final, then a new settings version it cannot crew comes.
 */
async function aKeptWorktree(trierarch: Trierarch) {
  trierarch.harness.isFailingLaunch = true;
  const shipId = await aCrewedShip(trierarch);
  trierarch.workspace.change(SCOUT_FOLDER);
  trierarch.fleet.requestAgain(shipId, crewSettings({ harness: 'codex' }));
  await trierarch.pass();
  trierarch.harness.isFailingLaunch = false;
  return shipId;
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

  it('row 7: removes a worktree with changes too, keeps none, ends the lease and confirms (#450)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.shipOf(shipId).status).toBe('awaitingCrew');
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.harness.identities.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.state.current().kept).toEqual([]);
    expect(trierarch.fleet.confirmed).toEqual([shipId]);
  });

  it('row 7: tells argo what removing the worktree discards, naming the machine, the ship and each unpushed change (#450)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER, ' M README.md');
    trierarch.workspace.change(SCOUT_FOLDER, '?? draft.md');
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([
      `mac-studio: released scout (${shipId}) and removed its aeolus-fleet worktree, discarding what was not pushed:  M README.md; ?? draft.md`,
    ]);
  });

  it('row 7: names what it discards in at most 4000 characters, then how many more, so the report is never too large to send (#450)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    for (let file = 0; file < 1000; file += 1) {
      trierarch.workspace.change(SCOUT_FOLDER, `?? notes/${String(file).padStart(4, '0')}.md`);
    }
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    const [text = ''] = trierarch.fleet.toArgo.map((report) => report.text);
    const named = text.split(': ').at(-1)?.split('; ') ?? [];
    const more = Number(/; and (\d+) more$/.exec(text)?.[1]);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(named.length - 1 + more).toBe(1000);
  });

  it('row 7: tells argo nothing when the worktree it removes holds nothing unpushed (#450)', async () => {
    const trierarch = aTrierarch();
    trierarch.fleet.removeRequest(await aCrewedShip(trierarch));

    await trierarch.pass();

    expect(trierarch.fleet.toArgo).toEqual([]);
  });

  it('row 7: tells argo once when removing the worktree fails and the next pass removes it (#450)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.removeRequest(shipId);
    trierarch.workspace.isFailingRemove = true;
    await trierarch.pass();
    trierarch.workspace.isFailingRemove = false;

    await trierarch.pass();

    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.fleet.confirmed).toEqual([shipId]);
    expect(trierarch.fleet.toArgo).toHaveLength(1);
  });

  it('a ship crewed again after its release starts in a fresh worktree, without what the crew before left (#450)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.removeRequest(shipId);
    await trierarch.pass();
    trierarch.fleet.request(shipId);

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.folder).toBe(SCOUT_FOLDER);
    expect(trierarch.workspace.folders.get(SCOUT_FOLDER)).toMatchObject({ hasChanges: false, unsaved: [] });
  });

  it('drops a kept worktree once it is gone from disk, as when a human removed it by hand (#325)', async () => {
    const trierarch = aTrierarch();
    await aKeptWorktree(trierarch);
    trierarch.workspace.folders.delete(SCOUT_FOLDER);

    await trierarch.pass();

    expect(trierarch.state.current().kept).toEqual([]);
    expect(trierarch.state.current().orphans).toEqual([]);
  });

  it('keeps a kept worktree that is still on disk, pass after pass', async () => {
    const trierarch = aTrierarch();
    const shipId = await aKeptWorktree(trierarch);

    await trierarch.pass();

    expect(trierarch.state.current().kept).toEqual([{ shipId, repository: 'aeolus-fleet', path: SCOUT_FOLDER }]);
  });

  it('clears a kept worktree its clear request names: removes it, drops it from kept and confirms it removed (decision 0032)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aKeptWorktree(trierarch);
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
    trierarch.workspace.folders.set(SCOUT_FOLDER, { hasChanges: true, unsaved: [] });
    trierarch.fleet.clearWorktree({ shipId, repository: 'aeolus-fleet' });

    await trierarch.pass();

    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(true);
    expect(trierarch.fleet.cleared).toEqual([{ shipId, repository: 'aeolus-fleet', outcome: 'not-kept' }]);
  });

  it('drops a kept worktree from kept once a ship is crewed in it again, so a clear request removes nothing in use (decision 0032)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aKeptWorktree(trierarch);
    trierarch.fleet.request(shipId);
    await trierarch.pass();
    trierarch.fleet.clearWorktree({ shipId, repository: 'aeolus-fleet' });

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.folder).toBe(SCOUT_FOLDER);
    expect(trierarch.state.current().kept).toEqual([]);
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(true);
    expect(trierarch.fleet.cleared).toEqual([{ shipId, repository: 'aeolus-fleet', outcome: 'not-kept' }]);
  });

  it('keeps a kept worktree and its clear request when removing it fails, so the next pass tries again', async () => {
    const trierarch = aTrierarch();
    const shipId = await aKeptWorktree(trierarch);
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
    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.state).toBe('running');
    expect(trierarch.fleet.shipOf(shipId).crewToken).not.toBe(lostToken);
    expect(trierarch.harness.identities.get(SCOUT_FOLDER)?.crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
  });

  it('row 8: a half-made worktree of an assigned ship is used when the crew resumes', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId);
    trierarch.workspace.folders.set(SCOUT_FOLDER, { shipId, hasChanges: false, unsaved: [] });

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
    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', settingsVersion: 2, options: { model: 'sonnet' }, folder: SCOUT_FOLDER });
    expect(trierarch.harness.launches).toHaveLength(2);
    expect(trierarch.workspace.folders.get(SCOUT_FOLDER)?.hasChanges).toBe(true);
    expect(trierarch.fleet.shipOf(shipId).status).toBe('crewed');
    expect(trierarch.harness.identities.get(SCOUT_FOLDER)?.crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
  });

  it('row 12: a new settings version starts a fresh session with its first prompt, never continuing the old conversation (#443)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch, { firstPrompt: 'Review the open pull requests.' });
    trierarch.fleet.requestAgain(shipId, crewSettings({ firstPrompt: 'Take slice 12.' }));

    await trierarch.pass();

    expect(trierarch.harness.launches.at(-1)).toEqual({
      shipId,
      shipName: 'scout',
      folder: SCOUT_FOLDER,
      workspace: { kind: 'worktree', repository: 'aeolus-fleet' },
      isFirstStart: true,
      firstPrompt: 'Take slice 12.',
    });
  });

  it('row 12: a session of the new settings version that dies continues its conversation, without the first prompt again (#443)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.requestAgain(shipId, crewSettings({ firstPrompt: 'Take slice 12.' }));
    await trierarch.pass();
    await trierarch.pass();
    trierarch.processes.exit(shipId);

    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    expect(trierarch.harness.launches.at(-1)).toEqual({ shipId, shipName: 'scout', folder: SCOUT_FOLDER, workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, isFirstStart: false });
  });

  it('row 12: a crashed request written again starts again with a fresh restart budget', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    await crashForGood(trierarch, shipId);

    trierarch.fleet.requestAgain(shipId);
    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', exits: [], folder: SCOUT_FOLDER });
    expect(trierarch.processes.sessions.get(shipId)).toBe('running');
    expect(trierarch.fleet.requestOf(shipId).status).toBe('running');
  });
});

describe('the launch window: a crew is final once its session shows activity (#382)', () => {
  it('keeps a ship it crewed crewing, writing no running, while its session shows no activity', async () => {
    const trierarch = aTrierarch();

    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' } });
    await trierarch.pass();

    expect(statusesOf(trierarch, shipId)).toEqual(['crewing']);
    expect(trierarch.state.current().entries[shipId]?.state).toBe('crewing');
    expect(trierarch.processes.sessions.get(shipId)).toBe('running');
    expect(trierarch.harness.launches).toHaveLength(1);
  });

  it('writes running once its session shows activity within the minute, with when the session started', async () => {
    const trierarch = aTrierarch();
    const startedAt = trierarch.clock.now();
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.clock.advance(20 * SECOND_MS);
    trierarch.harness.seen.set(shipId, { kind: 'active' });

    await trierarch.pass();

    expect(trierarch.fleet.statuses.filter((each) => each.shipId === shipId)).toEqual([
      { shipId, status: 'crewing', attempt: 0, startedAt: null },
      { shipId, status: 'running', attempt: 0, startedAt },
    ]);
    expect(trierarch.state.current().entries[shipId]?.state).toBe('running');
  });

  it('reads the screen of its session for the model it launched with', async () => {
    const trierarch = aTrierarch();

    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' }, settings: { options: { model: 'sonnet' } } });
    await trierarch.pass();

    expect(trierarch.harness.asked).toEqual([{ shipId, model: 'sonnet' }]);
  });

  it('gives the request back when its session refused the model it launched with, naming the harness, its version and the model: the session stops, its identity and clean worktree go', async () => {
    const trierarch = aTrierarch(CONFIGURATION, DETECTED);
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'refused', model: 'sonnet' }, settings: { options: { model: 'sonnet' } } });

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 1, reason: 'mac-studio: claude-code 2.1.295 refused sonnet' }]);
    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.harness.identities.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.state.current().entries).toEqual({});
    expect(trierarch.fleet.shipOf(shipId).status).toBe('awaitingCrew');
    expect(statusesOf(trierarch, shipId)).toEqual(['crewing']);
  });

  it('keeps the model its session refused as refused for its harness, and tells argo once, naming the machine, the harness, its version, the model and the ship', async () => {
    const trierarch = aTrierarch(CONFIGURATION, DETECTED);
    const refused = { seen: { kind: 'refused', model: 'sonnet' }, settings: { options: { model: 'sonnet' } } } as const;
    const shipId = await aLaunchedShip(trierarch, refused);
    await trierarch.pass();
    await aLaunchedShip(trierarch, refused);
    await trierarch.pass();

    expect(trierarch.refusals).toEqual([
      { harness: 'claude-code', id: 'sonnet', at: trierarch.clock.now() },
      { harness: 'claude-code', id: 'sonnet', at: trierarch.clock.now() },
    ]);
    expect(trierarch.fleet.toArgo).toEqual([
      {
        text: `mac-studio: claude-code 2.1.295 refused the model sonnet for scout (${shipId}): this machine offers it no more at this version, until aeolus-trierarch detect runs by hand`,
        idempotencyKey: 'trierarch:refused-model:claude-code:2.1.295:sonnet',
      },
    ]);
  });

  it("keeps nothing refused and tells argo nothing when its session refused the harness's own default", async () => {
    const trierarch = aTrierarch({ ...CONFIGURATION, harnesses: { 'claude-code': { flags: [], options: {} } } }, DETECTED);
    await aLaunchedShip(trierarch, { seen: { kind: 'refused', model: 'claude-opus-5-5' } });

    await trierarch.pass();

    expect(trierarch.refusals).toEqual([]);
    expect(trierarch.fleet.toArgo).toEqual([]);
  });

  it("names the model its session refused when it launched with none, the harness's own default", async () => {
    const trierarch = aTrierarch({ ...CONFIGURATION, harnesses: { 'claude-code': { flags: [], options: {} } } }, DETECTED);
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'refused', model: 'claude-opus-5-5' } });

    await trierarch.pass();

    expect(trierarch.harness.asked).toEqual([{ shipId }]);
    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 1, reason: 'mac-studio: claude-code 2.1.295 refused claude-opus-5-5' }]);
  });

  it('names the harness without a version when detection found none', async () => {
    const trierarch = aTrierarch();
    await aLaunchedShip(trierarch, { seen: { kind: 'refused', model: 'opus' } });

    await trierarch.pass();

    expect(trierarch.fleet.givenBack.map((each) => each.reason)).toEqual(['mac-studio: claude-code refused opus']);
  });

  it('gives the request back when its session shows no activity within a minute of its start', async () => {
    const trierarch = aTrierarch();
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 1, reason: 'mac-studio: no activity within a minute of its start' }]);
    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.state.current().entries).toEqual({});
  });

  it('names the screen its session stopped at when it gives the request back', async () => {
    const trierarch = aTrierarch();
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none', screen: 'bypass permissions warning' } });
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([
      { shipId, settingsVersion: 1, reason: "mac-studio: no activity within a minute of its start, stopped at claude-code's bypass permissions warning" },
    ]);
  });

  it('waits out the minute before it gives the request back', async () => {
    const trierarch = aTrierarch();
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.clock.advance(MINUTE_MS - SECOND_MS);

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([]);
    expect(trierarch.state.current().entries[shipId]?.state).toBe('crewing');
  });

  it('reads no screen once its session showed activity, and never gives a final crew back', async () => {
    const trierarch = aTrierarch();
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'active' } });
    await trierarch.pass();
    trierarch.harness.seen.set(shipId, { kind: 'none' });
    trierarch.clock.advance(2 * MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.harness.asked).toHaveLength(1);
    expect(trierarch.fleet.givenBack).toEqual([]);
    expect(trierarch.state.current().entries[shipId]?.state).toBe('running');
  });

  it('checks the start of a new settings version again: crewing until its session shows activity', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.seen.set(shipId, { kind: 'none' });
    trierarch.fleet.requestAgain(shipId, crewSettings({ options: { model: 'sonnet' } }));
    await trierarch.pass();
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 2, reason: 'mac-studio: no activity within a minute of its start' }]);
  });
});

/** A crewed ship whose session dies and starts again, showing what is given in its first minute: its id. */
async function aRestartedShip(trierarch: Trierarch, at: { seen: LaunchSeen; settings?: Record<string, unknown> }) {
  const shipId = await aCrewedShip(trierarch, at.settings);
  trierarch.harness.seen.set(shipId, at.seen);
  trierarch.processes.exit(shipId);
  await trierarch.pass();
  trierarch.clock.advance(5 * SECOND_MS);
  await trierarch.pass();
  return shipId;
}

/** Waits until the restarting entry starts again, then lets its first minute run out. */
async function failAgain(trierarch: Trierarch, shipId: ShipId) {
  const restartAt = trierarch.state.current().entries[shipId]?.restartAt;
  if (restartAt !== undefined) {
    trierarch.clock.advance(new Date(restartAt).getTime() - trierarch.clock.now().getTime());
  }
  await trierarch.pass();
  trierarch.clock.advance(MINUTE_MS);
  await trierarch.pass();
}

describe('the restart window: a restarted final crew is checked, never held back (#397)', () => {
  it('starts a restarted session at once and writes running while its first minute runs', async () => {
    const trierarch = aTrierarch();

    const shipId = await aRestartedShip(trierarch, { seen: { kind: 'none' } });

    expect(trierarch.processes.sessions.get(shipId)).toBe('running');
    expect(trierarch.state.current().entries[shipId]?.state).toBe('running');
    expect(statusesOf(trierarch, shipId)).toEqual(['crewing', 'running', 'restarting', 'running']);
  });

  it('watches the inbox of a restarted session and wakes it while its first minute runs', async () => {
    const trierarch = aTrierarch();
    const shipId = await aRestartedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 1);

    await trierarch.pass();

    expect(trierarch.harness.wakes).toEqual([shipId]);
  });

  it('reads the screen of a restarted session for the model it launched with', async () => {
    const trierarch = aTrierarch();
    const shipId = await aRestartedShip(trierarch, { seen: { kind: 'none' }, settings: { options: { model: 'sonnet' } } });

    await trierarch.pass();

    expect(trierarch.harness.asked.slice(1)).toEqual([{ shipId, model: 'sonnet' }]);
  });

  it('counts no activity within a minute of a restart as a failed start: the session stops and restarts after its wait, nothing given back', async () => {
    const trierarch = aTrierarch();
    const shipId = await aRestartedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'restarting', exits: [expect.any(String), expect.any(String)] });
    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(statusesOf(trierarch, shipId)).toEqual(['crewing', 'running', 'restarting', 'running', 'restarting']);
    expect(trierarch.fleet.givenBack).toEqual([]);
  });

  it('waits out the minute before it counts a failed start', async () => {
    const trierarch = aTrierarch();
    const shipId = await aRestartedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.clock.advance(MINUTE_MS - SECOND_MS);

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', exits: [expect.any(String)] });
  });

  it('counts a refused model on a restart as a failed start against the restart budget, nothing given back', async () => {
    const trierarch = aTrierarch(CONFIGURATION, DETECTED);
    const shipId = await aRestartedShip(trierarch, { seen: { kind: 'refused', model: 'sonnet' }, settings: { options: { model: 'sonnet' } } });

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'restarting', exits: [expect.any(String), expect.any(String)] });
    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.fleet.givenBack).toEqual([]);
  });

  it('keeps the model a restarted session refused as refused for its harness, and tells argo once', async () => {
    const trierarch = aTrierarch(CONFIGURATION, DETECTED);
    const shipId = await aRestartedShip(trierarch, { seen: { kind: 'refused', model: 'sonnet' }, settings: { options: { model: 'sonnet' } } });

    await trierarch.pass();

    expect(trierarch.refusals).toEqual([{ harness: 'claude-code', id: 'sonnet', at: trierarch.clock.now() }]);
    expect(trierarch.fleet.toArgo).toEqual([
      {
        text: `mac-studio: claude-code 2.1.295 refused the model sonnet for scout (${shipId}): this machine offers it no more at this version, until aeolus-trierarch detect runs by hand`,
        idempotencyKey: 'trierarch:refused-model:claude-code:2.1.295:sonnet',
      },
    ]);
  });

  it('once failed starts spend the restart budget, writes crashed and tells argo the reason, giving nothing back', async () => {
    const trierarch = aTrierarch();
    const shipId = await aRestartedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.clock.advance(MINUTE_MS);
    await trierarch.pass();

    for (let start = 1; start < RESTART_BUDGET; start += 1) {
      await failAgain(trierarch, shipId);
    }

    expect(trierarch.state.current().entries[shipId]?.state).toBe('crashed');
    expect(trierarch.fleet.requestOf(shipId).status).toBe('crashed');
    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.fleet.givenBack).toEqual([]);
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([
      `scout (${shipId}): its session crashed ${String(RESTART_BUDGET + 1)} times within an hour, restart budget spent; its last start: no activity within a minute of its start; status crashed. Restart it in the console to crew it again.`,
    ]);
  });

  it('checks the session started again after the machine restarts too', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.seen.set(shipId, { kind: 'none' });
    trierarch.processes.restartMachine();
    await trierarch.pass();
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'restarting', exits: [expect.any(String)] });
  });

  it('reads no screen once the restarted session showed activity', async () => {
    const trierarch = aTrierarch();
    const shipId = await aRestartedShip(trierarch, { seen: { kind: 'active' } });
    await trierarch.pass();
    trierarch.harness.seen.set(shipId, { kind: 'none' });
    trierarch.clock.advance(2 * MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.harness.asked).toHaveLength(2);
    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', exits: [expect.any(String)] });
  });
});

/** A crewed ship released elsewhere and crewed again by one pass, whose session shows what is given in its first minute: its id. */
async function aReleasedShip(trierarch: Trierarch, at: { seen: LaunchSeen; settings?: Record<string, unknown> }) {
  const shipId = await aCrewedShip(trierarch, at.settings);
  trierarch.harness.seen.set(shipId, at.seen);
  trierarch.fleet.releaseElsewhere(shipId);
  await trierarch.pass();
  return shipId;
}

describe('a final crew crewed again after a release elsewhere follows the restart rule (#469)', () => {
  it('counts no activity within a minute of crewing it again as a failed start: the session stops and restarts after its wait, nothing given back', async () => {
    const trierarch = aTrierarch();
    const shipId = await aReleasedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'restarting', exits: [expect.any(String)] });
    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.fleet.requestOf(shipId).status).toBe('restarting');
    expect(trierarch.fleet.givenBack).toEqual([]);
  });

  it('counts a refused model when crewed again as a failed start against the restart budget, nothing given back', async () => {
    const trierarch = aTrierarch(CONFIGURATION, DETECTED);
    const shipId = await aReleasedShip(trierarch, { seen: { kind: 'refused', model: 'sonnet' }, settings: { options: { model: 'sonnet' } } });

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'restarting', exits: [expect.any(String)] });
    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.fleet.givenBack).toEqual([]);
  });

  it('once failed starts spend the restart budget, writes crashed and tells argo the reason, giving nothing back', async () => {
    const trierarch = aTrierarch();
    const shipId = await aReleasedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.clock.advance(MINUTE_MS);
    await trierarch.pass();

    for (let start = 0; start < RESTART_BUDGET; start += 1) {
      await failAgain(trierarch, shipId);
    }

    expect(trierarch.state.current().entries[shipId]?.state).toBe('crashed');
    expect(trierarch.fleet.requestOf(shipId).status).toBe('crashed');
    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.fleet.givenBack).toEqual([]);
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([
      `scout (${shipId}): its session crashed ${String(RESTART_BUDGET + 1)} times within an hour, restart budget spent; its last start: no activity within a minute of its start; status crashed. Restart it in the console to crew it again.`,
    ]);
  });

  it('still gives the request back when its crew was not final yet as it was released elsewhere', async () => {
    const trierarch = aTrierarch();
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.fleet.releaseElsewhere(shipId);
    await trierarch.pass();
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 1, reason: 'mac-studio: no activity within a minute of its start' }]);
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
    trierarch.workspace.folders.set(orphan, { hasChanges: false, unsaved: [] });

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
    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.state).toBe('running');
  });

  it('crews settings with an option its harness does not declare, ignoring that option: no flag, no refusal (#366)', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings({ options: { model: 'sonnet', effort: 'high' } }));

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.toArgo).toEqual([]);
    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', options: { model: 'sonnet' } });
    expect(trierarch.state.current().entries[shipId]?.options).not.toHaveProperty('effort');
  });

  it.each([
    { label: 'a harness it does not offer', settings: crewSettings({ harness: 'codex' }), reason: 'harness: This trierarch offers no harness codex' },
    { label: 'a repository it does not offer', settings: crewSettings({ workspace: { kind: 'worktree', repository: 'hemma' } }), reason: 'workspace.repository: This trierarch offers no repository hemma' },
    { label: 'an option value it does not offer', settings: crewSettings({ options: { model: 'haiku' } }), reason: 'options.model: model must be one of opus, sonnet' },
    {
      label: 'no harness and an option value its default harness does not offer',
      settings: { workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: { model: 'haiku' } },
      reason: 'options.model: model must be one of opus, sonnet',
    },
    { label: 'settings that are not crew settings', settings: { harness: 'claude-code' }, reason: 'workspace: Invalid input: expected object, received undefined' },
  ])('does not crew settings with $label: it gives the request back with its machine and the field at fault as the reason, and tells argo nothing (#382)', async ({ settings, reason }) => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, settings);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.harness.launches).toEqual([]);
    expect(trierarch.fleet.statuses).toEqual([]);
    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 1, reason: `mac-studio: ${reason}` }]);
    expect(trierarch.fleet.requests.has(shipId)).toBe(false);
    expect(trierarch.fleet.toArgo).toEqual([]);
  });

  it('cuts the reason it gives back to 200 characters (#382)', async () => {
    const values = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`a-value-name-of-some-length-${String(index)}`, []]));
    const trierarch = aTrierarch({ ...CONFIGURATION, harnesses: { 'claude-code': { flags: [], options: { model: { values } } } } });
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings({ options: { model: 'haiku' } }));

    await trierarch.pass();

    const [given] = trierarch.fleet.givenBack;
    expect(given?.reason).toHaveLength(200);
    expect(given?.reason.startsWith('mac-studio: options.model: model must be one of a-value-name-of-some-length-0')).toBe(true);
  });

  it('tells argo once per version, as before, when the fleet holds its crew final already, as after its state was lost (#382)', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings({ harness: 'codex' }));
    trierarch.fleet.holdStatus(shipId, 'running');

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([]);
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([`scout (${shipId}): this trierarch cannot crew settings version 1: harness: This trierarch offers no harness codex`]);
  });

  it('tells argo once per version instead when the fleet refuses the give-back (#382)', async () => {
    const trierarch = aTrierarch();
    trierarch.fleet.isRefusingGiveBack = true;
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings({ harness: 'codex' }));

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.requests.has(shipId)).toBe(true);
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([`scout (${shipId}): this trierarch cannot crew settings version 1: harness: This trierarch offers no harness codex`]);
  });

  it('gives back a new settings version it cannot crew while its crew is not final: the session stops, its identity and clean worktree go, the lease ends (#382)', async () => {
    const trierarch = aTrierarch();
    trierarch.harness.isFailingLaunch = true;
    const shipId = await aCrewedShip(trierarch);
    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'crewing', folder: SCOUT_FOLDER });
    trierarch.fleet.requestAgain(shipId, crewSettings({ harness: 'codex' }));

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 2, reason: 'mac-studio: harness: This trierarch offers no harness codex' }]);
    expect(trierarch.state.current().entries).toEqual({});
    expect(trierarch.harness.identities.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.fleet.shipOf(shipId).status).toBe('awaitingCrew');
    expect(trierarch.fleet.toArgo).toEqual([]);
  });

  it('tells argo once, as before, of a new settings version it cannot crew once its crew is final: the session runs on (#382)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.requestAgain(shipId, crewSettings({ harness: 'codex' }));

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([]);
    expect(trierarch.processes.sessions.get(shipId)).toBe('running');
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([`scout (${shipId}): this trierarch cannot crew settings version 2: harness: This trierarch offers no harness codex`]);
  });

  it.each([
    {
      label: 'a repository',
      place: { kind: 'repository' as const, name: 'aeolus-fleet' },
      settings: crewSettings(),
      reason: 'workspace.repository: claude-code does not trust the repository aeolus-fleet: add it with aeolus-trierarch init, which trusts it',
    },
    {
      label: 'a folder',
      place: { kind: 'folder' as const, name: 'notes' },
      settings: crewSettings({ workspace: { kind: 'folder', name: 'notes' } }),
      reason: 'workspace.name: claude-code does not trust the folder notes: add it with aeolus-trierarch init, which trusts it',
    },
  ])('never crews settings in $label its harness does not trust, and gives the request back saying to add it with init (#381, #382)', async ({ place, settings, reason }) => {
    const trierarch = aTrierarch();
    trierarch.trust.untrust('claude-code', place);
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, settings);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.harness.launches).toEqual([]);
    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 1, reason: `mac-studio: ${reason}` }]);
    expect(trierarch.fleet.toArgo).toEqual([]);
  });

  it('gives back a request whose crew is not final yet once its harness no longer trusts the repository it would start in (#381, #382)', async () => {
    const trierarch = aTrierarch();
    trierarch.harness.isFailingLaunch = true;
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.isFailingLaunch = false;
    trierarch.trust.untrust('claude-code', { kind: 'repository', name: 'aeolus-fleet' });

    await trierarch.pass();

    expect(trierarch.harness.launches).toEqual([]);
    expect(trierarch.fleet.givenBack).toEqual([
      { shipId, settingsVersion: 1, reason: 'mac-studio: workspace.repository: claude-code does not trust the repository aeolus-fleet: add it with aeolus-trierarch init, which trusts it' },
    ]);
    expect(trierarch.state.current().entries).toEqual({});
  });

  it('checks trust with the harness the settings name: a repository only Codex does not trust is crewed on Claude Code (#381)', async () => {
    const trierarch = aTrierarch(WITH_CODEX);
    trierarch.trust.untrust('codex', { kind: 'repository', name: 'aeolus-fleet' });

    await aCrewedShip(trierarch);

    expect(trierarch.harness.launches).toHaveLength(1);
  });

  it('never starts a session again in a repository its harness no longer trusts (#381)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.trust.untrust('claude-code', { kind: 'repository', name: 'aeolus-fleet' });
    trierarch.processes.exit(shipId);

    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    expect(trierarch.harness.launches).toHaveLength(1);
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([
      `scout (${shipId}): this trierarch cannot crew settings version 1: workspace.repository: claude-code does not trust the repository aeolus-fleet: add it with aeolus-trierarch init, which trusts it`,
    ]);
  });

  it('never crews settings whose flags wait on a question its harness still asks, and gives the request back saying to accept it with init (#403)', async () => {
    const trierarch = aTrierarch(SKIPPING);
    trierarch.trust.unaccept('claude-code', SKIP);
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings());

    await trierarch.pass();

    expect(trierarch.harness.launches).toEqual([]);
    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 1, reason: `mac-studio: ${UNACCEPTED}` }]);
  });

  it('checks the flags the settings pick with an option against what its harness still asks (#403)', async () => {
    const trierarch = aTrierarch(SKIPPING_AS_OPTION);
    trierarch.trust.unaccept('claude-code', SKIP);
    const asking = trierarch.fleet.commission('scout');
    trierarch.fleet.request(asking, crewSettings());
    const skipping = trierarch.fleet.commission('ranger');
    trierarch.fleet.request(skipping, crewSettings({ workspace: { kind: 'folder', name: 'notes' }, options: { permissions: 'skip' } }));

    await trierarch.pass();

    expect(trierarch.harness.launches.map((launch) => launch.shipId)).toEqual([asking]);
    expect(trierarch.fleet.givenBack).toEqual([{ shipId: skipping, settingsVersion: 1, reason: `mac-studio: ${UNACCEPTED}` }]);
  });

  it('never starts a session again with a flag whose question its harness asks again (#403)', async () => {
    const trierarch = aTrierarch(SKIPPING);
    const shipId = await aCrewedShip(trierarch);
    trierarch.trust.unaccept('claude-code', SKIP);
    trierarch.processes.exit(shipId);

    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    expect(trierarch.harness.launches).toHaveLength(1);
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([`scout (${shipId}): this trierarch cannot crew settings version 1: ${UNACCEPTED}`]);
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

  it('crews settings without a harness with its default: the first harness in its configuration (#343)', async () => {
    const codexFirst = { ...CONFIGURATION, harnesses: { codex: { flags: [], options: {} }, ...CONFIGURATION.harnesses } };
    const trierarch = aTrierarch(codexFirst);
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, { workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} });

    await trierarch.pass();

    expect(trierarch.codex.launches).toHaveLength(1);
    expect(trierarch.harness.launches).toEqual([]);
    expect(trierarch.state.current().entries[shipId]?.harness).toBe('codex');
  });

  it('checks the options of settings without a harness against its default harness (#343)', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, { workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: { model: 'sonnet' } });

    await trierarch.pass();

    expect(trierarch.harness.launches).toEqual([expect.objectContaining({ shipId })]);
    expect(trierarch.state.current().entries[shipId]?.options).toEqual({ model: 'sonnet' });
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

  it('logs a release, saying its worktree was removed and how much it discarded', async () => {
    const clean = aTrierarch();
    clean.fleet.removeRequest(await aCrewedShip(clean));
    const changed = aTrierarch();
    const shipId = await aCrewedShip(changed);
    changed.workspace.change(SCOUT_FOLDER);
    changed.fleet.removeRequest(shipId);

    await clean.pass();
    await changed.pass();

    expect(logged(clean).at(-1)).toBe('release: released, its worktree removed');
    expect(logged(changed).at(-1)).toBe('release: released, its worktree removed, discarding 1 unpushed change, told to argo');
  });

  it('logs a clear, saying whether it removed the kept worktree or kept none', async () => {
    const trierarch = aTrierarch();
    const shipId = await aKeptWorktree(trierarch);
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
