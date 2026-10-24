import type { ShipId } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { aTrierarch, CONFIGURATION, crewSettings, InMemoryCheckouts, InMemoryShipSockets, newId, NOTES_FOLDER, WORKTREE_ROOT, type Trierarch } from '../../test/support/in-memory.js';
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
const UNMARKED = "harness: claude-code's aeolus plugin marks no launches: run aeolus-trierarch upgrade";

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
      socket: InMemoryShipSockets.pathOf(shipId),
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
      `scout crashed ${String(RESTART_BUDGET + 1)} times in an hour\n\n- Ship: scout (\`${shipId}\`)\n- Status: crashed, its restart budget spent\n\nRestart it in the console to crew it again.`,
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

  it('row 7: tells argo what removing the worktree discards, in a headline naming the ship, then the ship, its worktree, the counts per kind and each unpushed change (#450, #849)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER, ' M README.md');
    trierarch.workspace.change(SCOUT_FOLDER, '?? draft.md');
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([
      `scout released: unpushed work discarded\n\n- Ship: scout (\`${shipId}\`)\n- Worktree: aeolus-fleet\n- Discarded: 1 changed, 1 new\n\n- changed \`README.md\`\n- new \`draft.md\``,
    ]);
  });

  it('row 7: counts each kind of what it discards and names the first 5, then how many more are in the log (#450, #849)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    for (const line of [' D gone.md', 'D  staged-gone.md', ' M README.md', 'R  old.md -> new.md', 'A  added.md', '?? draft.md', `commit 1a2b3c4 work not pushed`]) {
      trierarch.workspace.change(SCOUT_FOLDER, line);
    }
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([
      [
        'scout released: unpushed work discarded',
        '',
        `- Ship: scout (\`${shipId}\`)`,
        '- Worktree: aeolus-fleet',
        '- Discarded: 2 deleted, 1 changed, 1 renamed, 2 new, 1 commit',
        '',
        '- deleted `gone.md`',
        '- deleted `staged-gone.md`',
        '- changed `README.md`',
        '- renamed `old.md -> new.md`',
        '- new `added.md`',
        "- and 2 more, in this trierarch's log",
      ].join('\n'),
    ]);
  });

  it('row 7: logs every line of what it discards, as argo is told only the first 5 (#849)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    for (let file = 0; file < 7; file += 1) {
      trierarch.workspace.change(SCOUT_FOLDER, `?? notes/${String(file)}.md`);
    }
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    expect(trierarch.logger.warnings).toContain(`Discarded from the worktree of scout (${shipId}), ${SCOUT_FOLDER}: ?? notes/0.md; ?? notes/1.md; ?? notes/2.md; ?? notes/3.md; ?? notes/4.md; ?? notes/5.md; ?? notes/6.md`);
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
    trierarch.workspace.folders.set(SCOUT_FOLDER, { hasChanges: true, unsaved: [' M README.md'] });
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
    expect(trierarch.state.current().entries[shipId]?.crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
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

  it('row 11: a ship released elsewhere has its session stopped and is crewed again', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    const firstToken = trierarch.fleet.shipOf(shipId).crewToken;
    trierarch.fleet.releaseElsewhere(shipId);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.shipOf(shipId).status).toBe('crewed');
    expect(trierarch.fleet.shipOf(shipId).crewToken).not.toBe(firstToken);
    expect(trierarch.state.current().entries[shipId]?.crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
    expect(trierarch.harness.launches.map((launch) => launch.folder)).toEqual([SCOUT_FOLDER, SCOUT_FOLDER]);
    expect(trierarch.state.current().entries[shipId]?.state).toBe('running');
  });

  it('row 11: a ship released elsewhere is crewed again in a fresh worktree, without what the crew before left (#475)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.releaseElsewhere(shipId);

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.folder).toBe(SCOUT_FOLDER);
    expect(trierarch.workspace.folders.get(SCOUT_FOLDER)).toMatchObject({ hasChanges: false, unsaved: [] });
    expect(trierarch.state.current().kept).toEqual([]);
  });

  it('row 11: tells argo what removing the worktree of a ship released elsewhere discards, saying why, then the ship, its worktree, the counts and each unpushed change (#475, #849)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER, ' M README.md');
    trierarch.workspace.change(SCOUT_FOLDER, '?? draft.md');
    trierarch.fleet.releaseElsewhere(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([
      `scout released elsewhere: unpushed work discarded\n\nThe trierarch removed its worktree before crewing it again.\n\n- Ship: scout (\`${shipId}\`)\n- Worktree: aeolus-fleet\n- Discarded: 1 changed, 1 new\n\n- changed \`README.md\`\n- new \`draft.md\``,
    ]);
  });

  it('row 11: tells argo nothing when the worktree of a ship released elsewhere holds nothing unpushed (#475)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.releaseElsewhere(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.toArgo).toEqual([]);
  });

  it('row 11: when removing the worktree of a ship released elsewhere fails, crews it nowhere and the next pass removes it, telling argo once (#475)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.releaseElsewhere(shipId);
    trierarch.workspace.isFailingRemove = true;
    await trierarch.pass();
    const launchesAfterFailure = trierarch.harness.launches.length;
    trierarch.workspace.isFailingRemove = false;

    await trierarch.pass();

    expect(launchesAfterFailure).toBe(1);
    expect(trierarch.workspace.folders.get(SCOUT_FOLDER)).toMatchObject({ hasChanges: false, unsaved: [] });
    expect(trierarch.fleet.shipOf(shipId).status).toBe('crewed');
    expect(trierarch.fleet.toArgo).toHaveLength(1);
  });

  it('row 11: a ship released elsewhere is crewed again as a first start, with its first prompt and no resume (#475)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch, { firstPrompt: 'Review the open pull requests.' });
    trierarch.fleet.releaseElsewhere(shipId);

    await trierarch.pass();

    expect(trierarch.harness.launches.at(-1)).toEqual({
      shipId,
      shipName: 'scout',
      folder: SCOUT_FOLDER,
      workspace: { kind: 'worktree', repository: 'aeolus-fleet' },
      isFirstStart: true,
      firstPrompt: 'Review the open pull requests.',
    });
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
    expect(trierarch.state.current().entries[shipId]?.crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
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

  it('starts its session with a fresh launch id and reads that launch of its session, for the model it launched with (#490)', async () => {
    const trierarch = aTrierarch();

    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' }, settings: { options: { model: 'sonnet' } } });
    await trierarch.pass();

    expect(trierarch.harness.launchIds).toEqual(['launch-1']);
    expect(trierarch.harness.asked).toEqual([{ shipId, folder: SCOUT_FOLDER, launchId: 'launch-1', model: 'sonnet' }]);
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

  it('keeps the model its session refused as refused for its harness, and tells argo once, naming the harness, its version, the model and the ship', async () => {
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
        text: `claude-code refused the model sonnet for scout\n\n- Ship: scout (\`${shipId}\`)\n- Harness: claude-code 2.1.295\n- Model: sonnet\n\nThis machine offers the model no more at this version, until \`aeolus-trierarch detect\` runs by hand.`,
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

    expect(trierarch.harness.asked).toEqual([{ shipId, folder: SCOUT_FOLDER, launchId: 'launch-1' }]);
    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 1, reason: 'mac-studio: claude-code 2.1.295 refused claude-opus-5-5' }]);
  });

  it('says its default model was refused when its session refused a model it does not name (#490)', async () => {
    const trierarch = aTrierarch({ ...CONFIGURATION, harnesses: { 'claude-code': { flags: [], options: {} } } }, DETECTED);
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'refused' } });

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 1, reason: 'mac-studio: claude-code 2.1.295 refused its default model' }]);
    expect(trierarch.refusals).toEqual([]);
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

    expect(trierarch.harness.handOvers).toEqual([shipId]);
  });

  it('starts a restarted session with a fresh launch id and reads that launch, for the model it launched with (#490)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aRestartedShip(trierarch, { seen: { kind: 'none' }, settings: { options: { model: 'sonnet' } } });

    await trierarch.pass();

    expect(trierarch.harness.launchIds).toEqual(['launch-1', 'launch-2']);
    expect(trierarch.harness.asked.slice(1)).toEqual([{ shipId, folder: SCOUT_FOLDER, launchId: 'launch-2', model: 'sonnet' }]);
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
        text: `claude-code refused the model sonnet for scout\n\n- Ship: scout (\`${shipId}\`)\n- Harness: claude-code 2.1.295\n- Model: sonnet\n\nThis machine offers the model no more at this version, until \`aeolus-trierarch detect\` runs by hand.`,
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
      `scout crashed ${String(RESTART_BUDGET + 1)} times in an hour\n\n- Ship: scout (\`${shipId}\`)\n- Status: crashed, its restart budget spent\n- Its last start: no activity within a minute of its start\n\nRestart it in the console to crew it again.`,
    ]);
  });

  it('names the screen a restarted session stopped at in the reason argo is told, as the first start does (#474)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aRestartedShip(trierarch, { seen: { kind: 'none', screen: 'bypass permissions warning' } });
    trierarch.clock.advance(MINUTE_MS);
    await trierarch.pass();

    for (let start = 1; start < RESTART_BUDGET; start += 1) {
      await failAgain(trierarch, shipId);
    }

    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([
      `scout crashed ${String(RESTART_BUDGET + 1)} times in an hour\n\n- Ship: scout (\`${shipId}\`)\n- Status: crashed, its restart budget spent\n- Its last start: no activity within a minute of its start, stopped at claude-code's bypass permissions warning\n\nRestart it in the console to crew it again.`,
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
      `scout crashed ${String(RESTART_BUDGET + 1)} times in an hour\n\n- Ship: scout (\`${shipId}\`)\n- Status: crashed, its restart budget spent\n- Its last start: no activity within a minute of its start\n\nRestart it in the console to crew it again.`,
    ]);
  });

  it('gives nothing back once its harness no longer trusts the repository, as the fleet holds its crew final while its status says crewing: its worktree stays and argo is told once (#477)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aReleasedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.trust.untrust('claude-code', { kind: 'repository', name: 'aeolus-fleet' });
    trierarch.processes.restartMachine();

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.requestOf(shipId)).toMatchObject({ status: 'crewing', isFinal: true });
    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'crewing', folder: SCOUT_FOLDER });
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(true);
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([
      `Cannot crew scout with its settings\n\n- Ship: scout (\`${shipId}\`)\n- Settings version: 1\n- Why: workspace.repository: claude-code does not trust the repository aeolus-fleet: add it with aeolus-trierarch init, which trusts it`,
    ]);
  });

  it('counts no activity within a minute as a failed start, nothing given back, when the fleet holds its crew final as its state was lost (#477)', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings());
    trierarch.fleet.holdStatus(shipId, 'running');
    trierarch.harness.seen.set(shipId, { kind: 'none' });
    await trierarch.pass();
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'restarting', exits: [expect.any(String)] });
    expect(trierarch.fleet.givenBack).toEqual([]);
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

describe('a session is watched and woken from the moment it runs, whatever the crew status (#473)', () => {
  it('wakes a ship crewed again after a release elsewhere before its session shows activity', async () => {
    const trierarch = aTrierarch();
    const shipId = await aReleasedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 1);

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.state).toBe('crewing');
    expect(trierarch.harness.handOvers).toEqual([shipId]);
  });

  it('wakes a first crew before its session shows activity', async () => {
    const trierarch = aTrierarch();
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 1);

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.state).toBe('crewing');
    expect(trierarch.harness.handOvers).toEqual([shipId]);
  });

  it('wakes a session in the pass its activity makes its crew final', async () => {
    const trierarch = aTrierarch();
    const shipId = await aReleasedShip(trierarch, { seen: { kind: 'active' } });
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 1);

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.state).toBe('running');
    expect(trierarch.harness.handOvers).toEqual([shipId]);
  });

  it('wakes a crewing session no more once its start failed', async () => {
    const trierarch = aTrierarch();
    const shipId = await aReleasedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 1);
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.harness.handOvers).toEqual([]);
  });
});

describe('a first crew released elsewhere in its launch window is crewed again, never released or given back (row 11, #482)', () => {
  it('stops its session and crews it again as a first start, with its first prompt', async () => {
    const trierarch = aTrierarch();
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' }, settings: { firstPrompt: 'Review the open pull requests.' } });
    const firstToken = trierarch.fleet.shipOf(shipId).crewToken;
    trierarch.fleet.releaseElsewhere(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.shipOf(shipId)).toMatchObject({ status: 'crewed' });
    expect(trierarch.fleet.shipOf(shipId).crewToken).not.toBe(firstToken);
    expect(trierarch.harness.launches.map((launch) => ({ isFirstStart: launch.isFirstStart, firstPrompt: launch.firstPrompt }))).toEqual([
      { isFirstStart: true, firstPrompt: 'Review the open pull requests.' },
      { isFirstStart: true, firstPrompt: 'Review the open pull requests.' },
    ]);
  });

  it('gives nothing back, confirms no release and writes no status beyond crewing', async () => {
    const trierarch = aTrierarch();
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.fleet.releaseElsewhere(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([]);
    expect(trierarch.fleet.confirmed).toEqual([]);
    expect(trierarch.fleet.requestOf(shipId)).toMatchObject({ status: 'crewing', isFinal: false });
    expect(trierarch.state.current().entries[shipId]?.state).toBe('crewing');
  });

  it('counts the minute of its launch window from the start after the release', async () => {
    const trierarch = aTrierarch();
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.clock.advance(MINUTE_MS - SECOND_MS);
    trierarch.fleet.releaseElsewhere(shipId);
    await trierarch.pass();
    trierarch.clock.advance(MINUTE_MS - SECOND_MS);

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([]);
    expect(trierarch.state.current().entries[shipId]?.state).toBe('crewing');
  });

  it('writes running, with when the start after the release began, once that session shows activity', async () => {
    const trierarch = aTrierarch();
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'none' } });
    trierarch.clock.advance(20 * SECOND_MS);
    trierarch.fleet.releaseElsewhere(shipId);
    await trierarch.pass();
    const startedAgainAt = trierarch.clock.now();
    trierarch.clock.advance(20 * SECOND_MS);
    trierarch.harness.seen.set(shipId, { kind: 'active' });

    await trierarch.pass();

    expect(trierarch.fleet.statuses.filter((each) => each.shipId === shipId).at(-1)).toEqual({ shipId, status: 'running', attempt: 0, startedAt: startedAgainAt });
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

  it('rule 2: a clean worktree under its root with no assigned request is removed, with what runs in it stopped first (#1041)', async () => {
    const trierarch = aTrierarch();
    const orphan = `${WORKTREE_ROOT}/aeolus-fleet/lookout`;
    trierarch.workspace.folders.set(orphan, { hasChanges: false, unsaved: [] });
    trierarch.folderProcesses.start(orphan, 'astro dev');

    await trierarch.pass();

    expect(trierarch.folderProcesses.running.has(orphan)).toBe(false);
    expect(trierarch.workspace.folders.has(orphan)).toBe(false);
    expect(trierarch.state.current().orphans).toEqual([]);
  });

  it('rule 2: a worktree with no assigned request that holds unsaved work is kept and reported as an orphan, with what runs in it stopped (#1041)', async () => {
    const trierarch = aTrierarch();
    const orphan = `${WORKTREE_ROOT}/aeolus-fleet/lookout`;
    trierarch.workspace.folders.set(orphan, { hasChanges: true, unsaved: [' M README.md'] });
    trierarch.folderProcesses.start(orphan, 'wrangler dev');

    await trierarch.pass();

    expect(trierarch.folderProcesses.running.has(orphan)).toBe(false);
    expect(trierarch.workspace.folders.has(orphan)).toBe(true);
    expect(trierarch.state.current().orphans).toEqual([{ path: orphan, repository: 'aeolus-fleet', name: 'lookout' }]);
  });

  it('rule 2: an orphan it could not remove is reported and tried again on the next pass (#1041)', async () => {
    const trierarch = aTrierarch();
    const orphan = `${WORKTREE_ROOT}/aeolus-fleet/lookout`;
    trierarch.workspace.folders.set(orphan, { hasChanges: false, unsaved: [] });
    trierarch.workspace.isFailingRemove = true;

    await trierarch.pass();

    expect(trierarch.workspace.folders.has(orphan)).toBe(true);
    expect(trierarch.state.current().orphans).toEqual([{ path: orphan, repository: 'aeolus-fleet', name: 'lookout' }]);

    trierarch.workspace.isFailingRemove = false;
    await trierarch.pass();

    expect(trierarch.workspace.folders.has(orphan)).toBe(false);
    expect(trierarch.state.current().orphans).toEqual([]);
  });

  it('rule 2: an orphan whose processes cannot be stopped is not removed (#1041)', async () => {
    const trierarch = aTrierarch();
    const orphan = `${WORKTREE_ROOT}/aeolus-fleet/lookout`;
    trierarch.workspace.folders.set(orphan, { hasChanges: false, unsaved: [] });
    trierarch.folderProcesses.isFailingStop = true;

    await trierarch.pass();

    expect(trierarch.workspace.folders.has(orphan)).toBe(true);
    expect(trierarch.state.current().orphans).toEqual([{ path: orphan, repository: 'aeolus-fleet', name: 'lookout' }]);
  });

  it('rule 2: a worktree an entry works in is never cleared as an orphan, nor are the processes in it stopped (#1041)', async () => {
    const trierarch = aTrierarch();
    await aCrewedShip(trierarch);
    trierarch.folderProcesses.start(SCOUT_FOLDER, 'astro dev');

    await trierarch.pass();

    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(true);
    expect(trierarch.folderProcesses.stoppedIn).toEqual([]);
  });

  it('rule 2: a request no longer assigned to it, as when its ship is retired, has its session stopped and its clean worktree removed with what runs in it (#1041)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.folderProcesses.start(SCOUT_FOLDER, 'astro dev');
    trierarch.fleet.unassign(shipId);

    await trierarch.pass();

    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.state.current().entries).toEqual({});
    expect(trierarch.harness.identities.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.folderProcesses.running.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.state.current().orphans).toEqual([]);
  });

  it('rule 2: a request no longer assigned to it keeps its worktree as an orphan while it holds unsaved work (#1041)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    trierarch.fleet.unassign(shipId);

    await trierarch.pass();

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
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([`Cannot crew scout with its settings\n\n- Ship: scout (\`${shipId}\`)\n- Settings version: 1\n- Why: harness: This trierarch offers no harness codex`]);
  });

  it('tells argo once per version instead when the fleet refuses the give-back (#382)', async () => {
    const trierarch = aTrierarch();
    trierarch.fleet.isRefusingGiveBack = true;
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings({ harness: 'codex' }));

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.requests.has(shipId)).toBe(true);
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([`Cannot crew scout with its settings\n\n- Ship: scout (\`${shipId}\`)\n- Settings version: 1\n- Why: harness: This trierarch offers no harness codex`]);
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

  it('gives back a new settings version it cannot crew of a ship whose crew ran, as the new version clears final: the session stops, its identity and clean worktree go (#477)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.requestAgain(shipId, crewSettings({ harness: 'codex' }));

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 2, reason: 'mac-studio: harness: This trierarch offers no harness codex' }]);
    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.state.current().entries).toEqual({});
    expect(trierarch.harness.identities.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.fleet.toArgo).toEqual([]);
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
      `Cannot crew scout with its settings\n\n- Ship: scout (\`${shipId}\`)\n- Settings version: 1\n- Why: workspace.repository: claude-code does not trust the repository aeolus-fleet: add it with aeolus-trierarch init, which trusts it`,
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
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([`Cannot crew scout with its settings\n\n- Ship: scout (\`${shipId}\`)\n- Settings version: 1\n- Why: ${UNACCEPTED}`]);
  });

  it('never crews settings for a harness whose aeolus plugin marks no launches, and gives the request back saying to upgrade (#490)', async () => {
    const trierarch = aTrierarch();
    trierarch.harness.isMarkingLaunches = false;
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings());

    await trierarch.pass();

    expect(trierarch.harness.launches).toEqual([]);
    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 1, reason: `mac-studio: ${UNMARKED}` }]);
  });

  it('never starts a session again for a harness whose aeolus plugin marks no launches, and tells argo once (#490)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.isMarkingLaunches = false;
    trierarch.processes.exit(shipId);

    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    expect(trierarch.harness.launches).toHaveLength(1);
    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([`Cannot crew scout with its settings\n\n- Ship: scout (\`${shipId}\`)\n- Settings version: 1\n- Why: ${UNMARKED}`]);
  });

  it('a harness whose aeolus plugin is missing gives back only its own requests, with why, and the pass goes on for the others (#1212)', async () => {
    const trierarch = aTrierarch();
    trierarch.codex.pluginProblem = 'The aeolus plugin is not installed for Codex (nothing in /home/thomas/.codex/plugins/cache/aeolus-fleet/aeolus)';
    const codexShip = trierarch.fleet.commission('lookout');
    trierarch.fleet.request(codexShip, crewSettings({ harness: 'codex' }));
    const claudeShip = trierarch.fleet.commission('scout');
    trierarch.fleet.request(claudeShip, crewSettings());

    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([{ shipId: codexShip, settingsVersion: 1, reason: "mac-studio: harness: codex's aeolus plugin is not installed: run aeolus-trierarch upgrade" }]);
    expect(trierarch.harness.launches.map((launch) => launch.shipId)).toEqual([claudeShip]);
    expect(trierarch.codex.launches).toEqual([]);
    expect(trierarch.logger.warnings.some((warning) => warning.startsWith('The pass failed'))).toBe(false);
  });

  it('a pass that fails is kept in the state with why and since when, and cleared once a pass succeeds (#1212)', async () => {
    const trierarch = aTrierarch();
    trierarch.fleet.isUnreachable = true;
    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    expect(trierarch.state.current().passFailure).toEqual({ reason: 'the fleet cannot be reached', since: '2026-10-06T08:00:00.000Z' });

    trierarch.fleet.isUnreachable = false;
    await trierarch.pass();

    expect(trierarch.state.current().passFailure).toBeUndefined();
  });

  it('hands one message over to an idle session while deliveries wait (#756, 2a)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 1);

    await trierarch.pass();

    expect(trierarch.harness.handOvers).toEqual([shipId]);
  });

  it('hands nothing more while the hand-over keeps the session busy', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 2);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.harness.handOvers).toEqual([shipId]);
  });

  it('hands the next message over once the session is idle again, though the count did not rise', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 1);
    await trierarch.pass();

    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    await trierarch.pass();

    expect(trierarch.harness.handOvers).toEqual([shipId, shipId]);
  });

  it('hands over what the store holds to an idle session, though nothing waits at the fleet: received, not confirmed or to hand once more (3.2, 3.7, 3.9)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.harness.holding.add(SCOUT_FOLDER);

    await trierarch.pass();

    expect(trierarch.harness.handOvers).toEqual([shipId]);
  });

  it('hands nothing to an idle session while nothing waits and its store holds nothing', async () => {
    const trierarch = aTrierarch();
    await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');

    await trierarch.pass();

    expect(trierarch.harness.handOvers).toEqual([]);
  });

  it('hands a forced message over to a busy session, stopping its turn (decision 0040)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'busy');
    trierarch.fleet.deliver(shipId, 1);
    trierarch.fleet.force(shipId, 1);

    await trierarch.pass();

    expect(trierarch.harness.forcedOver).toEqual([{ shipId, isTurnStopped: true }]);
    expect(trierarch.harness.handOvers).toEqual([]);
  });

  it('hands a forced message to an idle session first, before what its store holds, stopping no turn', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.harness.holding.add(SCOUT_FOLDER);
    trierarch.fleet.deliver(shipId, 2);
    trierarch.fleet.force(shipId, 1);

    await trierarch.pass();

    expect(trierarch.harness.forcedOver).toEqual([{ shipId, isTurnStopped: false }]);
    expect(trierarch.harness.handOvers).toEqual([]);
  });

  it('hands nothing, forced or not, to a session whose turn is not marked yet', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.deliver(shipId, 1);
    trierarch.fleet.force(shipId, 1);

    await trierarch.pass();

    expect(trierarch.harness.forcedOver).toEqual([]);
    expect(trierarch.harness.handOvers).toEqual([]);
  });

  it('tells the store its session died before it starts the session again (3.5 to 3.7)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.exit(shipId);

    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    expect(trierarch.harness.died).toEqual([{ shipId, launchesBefore: 1 }]);
    expect(trierarch.harness.launches).toHaveLength(2);
  });

  it('tells the store its session died when the machine restarted, before it starts it again (3.10)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.restartMachine();

    await trierarch.pass();

    expect(trierarch.harness.died).toEqual([{ shipId, launchesBefore: 1 }]);
  });

  it('tells the store nothing while its session runs on, as after the trierarch itself restarted (3.3)', async () => {
    const trierarch = aTrierarch();
    await aCrewedShip(trierarch);

    await trierarch.pass();

    expect(trierarch.harness.died).toEqual([]);
  });

  it('hands nothing to a busy session, and hands over once it turns idle', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'busy');
    trierarch.fleet.deliver(shipId, 1);
    await trierarch.pass();
    expect(trierarch.harness.handOvers).toEqual([]);

    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    await trierarch.pass();

    expect(trierarch.harness.handOvers).toEqual([shipId]);
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

    expect(trierarch.codex.handOvers).toEqual([shipId]);
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

  it('logs a hand-over', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.fleet.deliver(shipId, 1);

    await trierarch.pass();

    expect(logged(trierarch).at(-1)).toBe('wake: handed a message over');
  });

  it('logs a forced hand-over, saying when it stopped a busy turn for it', async () => {
    const busy = aTrierarch();
    const busyShip = await aCrewedShip(busy);
    busy.harness.turns.set(SCOUT_FOLDER, 'busy');
    busy.fleet.deliver(busyShip, 1);
    busy.fleet.force(busyShip, 1);
    const idle = aTrierarch();
    const idleShip = await aCrewedShip(idle);
    idle.harness.turns.set(SCOUT_FOLDER, 'idle');
    idle.fleet.deliver(idleShip, 1);
    idle.fleet.force(idleShip, 1);

    await busy.pass();
    await idle.pass();

    expect(logged(busy).at(-1)).toBe('wake: stopped its turn and handed a forced message over');
    expect(logged(idle).at(-1)).toBe('wake: handed a forced message over');
  });

  it('logs nothing when the plugin had nothing to hand over, as when another ship of its type took the delivery first', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.harness.turns.set(SCOUT_FOLDER, 'idle');
    trierarch.harness.isHandingNothing = true;
    trierarch.fleet.deliver(shipId, 1);
    const before = logged(trierarch).length;

    await trierarch.pass();

    expect(logged(trierarch)).toHaveLength(before);
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

  it('logs a failure with its ship and what happens next', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId);
    trierarch.fleet.isLosingRegisterReply = true;

    await trierarch.pass();

    expect(trierarch.logger.actions).toEqual([
      {
        time: trierarch.clock.now(),
        shipId,
        shipName: 'scout',
        action: 'crew',
        outcome: 'failed: the register reply was lost',
        next: 'the next pass tries again; aeolus-trierarch status and list show where it stands',
      },
    ]);
  });
});

describe('a Codex launch on a version other than the one its texts were captured on (#490)', () => {
  /** A version newer than any whose screens or logs the Codex adapter was tested on. */
  const NEWER = '0.163.0';
  /** Codex as detection found it on the machine, at the version given. */
  const codexAt = (version: string) => ({ codex: { version, detectedAt: new Date('2026-10-09T08:00:00Z'), confirmedAt: null, options: {} } });

  /** A ship crewed with Codex by one pass, whose session shows what is given in its launch window: its id. */
  async function aCodexLaunch(trierarch: Trierarch, seen: LaunchSeen) {
    const shipId = trierarch.fleet.commission('scout');
    trierarch.codex.seen.set(shipId, seen);
    trierarch.fleet.request(shipId, crewSettings({ harness: 'codex' }));
    await trierarch.pass();
    return shipId;
  }

  it('tells argo nothing of its version when its session shows no activity within a minute: activity and refusal come from the hooks and the session log, not the screen', async () => {
    const trierarch = aTrierarch(WITH_CODEX, codexAt(NEWER));
    await aCodexLaunch(trierarch, { kind: 'none' });
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.fleet.toArgo).toEqual([]);
  });

  it('tells argo nothing of its version when a restarted session shows no activity within a minute', async () => {
    const trierarch = aTrierarch(WITH_CODEX, codexAt(NEWER));
    const shipId = await aCodexLaunch(trierarch, { kind: 'active' });
    await trierarch.pass();
    trierarch.codex.seen.set(shipId, { kind: 'none' });
    trierarch.processes.exit(shipId);
    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.fleet.toArgo).toEqual([]);
  });
});

/** What argo is told when a ship's folder holds no identity (#659, #664). */
const identityGone = (shipId: ShipId) =>
  `scout is no longer woken: its folder holds no identity\n\n- Ship: scout (\`${shipId}\`)\n\nThe trierarch can no longer report on its behalf, watch its inbox or wake it. Restart it in the console to crew it again.`;

describe('a running ship whose identity is gone (#659)', () => {
  it('tells argo once and logs it once while its folder holds no identity', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    await trierarch.harness.removeIdentity({ shipId, folder: SCOUT_FOLDER });

    await trierarch.pass();
    trierarch.clock.advance(MINUTE_MS);
    await trierarch.pass();

    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([identityGone(shipId)]);
    expect(trierarch.logger.actions.filter((each) => each.action === 'identityGone').map((each) => each.outcome)).toEqual(['its folder holds no identity, so it is no longer woken; argo told']);
  });

  it('tells argo again when its identity is gone again after it came back', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    const identity = trierarch.harness.identities.get(SCOUT_FOLDER);
    await trierarch.harness.removeIdentity({ shipId, folder: SCOUT_FOLDER });
    await trierarch.pass();
    if (identity !== undefined) {
      await trierarch.harness.prepareIdentity({ folder: SCOUT_FOLDER, identity, crewToken: trierarch.fleet.shipOf(shipId).crewToken ?? '' });
    }
    trierarch.clock.advance(MINUTE_MS);
    await trierarch.pass();
    await trierarch.harness.removeIdentity({ shipId, folder: SCOUT_FOLDER });
    trierarch.clock.advance(MINUTE_MS);

    await trierarch.pass();

    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([identityGone(shipId), identityGone(shipId)]);
  });

  it('tells argo nothing while its folder holds its identity', async () => {
    const trierarch = aTrierarch();
    await aCrewedShip(trierarch);

    await trierarch.pass();

    expect(trierarch.fleet.toArgo).toEqual([]);
  });
});

describe('a ship the trierarch would report as blocked whose identity is gone (#664)', () => {
  const logged = (trierarch: Trierarch) => trierarch.logger.actions.map(({ action, outcome }) => `${action}: ${outcome}`);

  it('tells argo once when its session exits in the same pass its identity is gone', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.exit(shipId);
    await trierarch.harness.removeIdentity({ shipId, folder: SCOUT_FOLDER });

    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();
    trierarch.clock.advance(MINUTE_MS);
    await trierarch.pass();

    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([identityGone(shipId)]);
  });

  it('logs the blocked report it cannot send, and argo told, when its session exits in the same pass its identity is gone', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.exit(shipId);
    await trierarch.harness.removeIdentity({ shipId, folder: SCOUT_FOLDER });

    await trierarch.pass();

    expect(logged(trierarch).slice(1)).toEqual([
      'report: not reported blocked: session crashed, restarting, as its folder holds no identity',
      'identityGone: its folder holds no identity, so it is no longer woken; argo told',
    ]);
  });

  it('tells argo once when its identity is gone while it restarts', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.exit(shipId);
    await trierarch.pass();
    await trierarch.harness.removeIdentity({ shipId, folder: SCOUT_FOLDER });

    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();
    trierarch.clock.advance(MINUTE_MS);
    await trierarch.pass();

    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([identityGone(shipId)]);
  });

  it('tells argo once when its identity is gone once it crashed', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    await crashForGood(trierarch, shipId);
    const crashed = trierarch.fleet.toArgo.length;
    await trierarch.harness.removeIdentity({ shipId, folder: SCOUT_FOLDER });

    await trierarch.pass();
    trierarch.clock.advance(MINUTE_MS);
    await trierarch.pass();

    expect(trierarch.fleet.toArgo.slice(crashed).map((report) => report.text)).toEqual([identityGone(shipId)]);
  });
});

describe('a failing action fails alone (#827)', () => {
  /** A ship crewed with Codex, commissioned first so its crew comes first in the pass: its id. */
  function aCodexShip(trierarch: Trierarch) {
    const shipId = trierarch.fleet.commission('broken');
    trierarch.fleet.request(shipId, crewSettings({ harness: 'codex' }));
    return shipId;
  }

  it('crews the other ships in the same pass when one crew always fails', async () => {
    const trierarch = aTrierarch(WITH_CODEX);
    trierarch.codex.isFailingLaunch = true;
    aCodexShip(trierarch);
    const scout = trierarch.fleet.commission('scout');
    trierarch.fleet.request(scout);

    await trierarch.pass();

    expect(trierarch.harness.launches.map((launch) => launch.shipId)).toEqual([scout]);
    expect(trierarch.fleet.shipOf(scout).status).toBe('crewed');
  });

  it('registers no ship whose harness cannot start a session, and logs why', async () => {
    const trierarch = aTrierarch(WITH_CODEX);
    trierarch.codex.problem = "the aeolus plugin's scripts are not at /home/thomas/.codex/plugins/cache/aeolus-fleet/aeolus/0.25.0";
    const shipId = aCodexShip(trierarch);

    await trierarch.pass();

    expect(trierarch.fleet.shipOf(shipId).status).toBe('awaitingCrew');
    expect(trierarch.logger.actions.map((logged) => logged.outcome)).toContain(
      "failed: the aeolus plugin's scripts are not at /home/thomas/.codex/plugins/cache/aeolus-fleet/aeolus/0.25.0",
    );
  });

  it('keeps a request whose crew failed twice in a row', async () => {
    const trierarch = aTrierarch(WITH_CODEX);
    trierarch.codex.isFailingLaunch = true;
    const shipId = aCodexShip(trierarch);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([]);
    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'crewing' });
  });

  it('gives the request back once its crew failed 3 times in a row, the last failure as its reason, so another trierarch can crew it', async () => {
    const trierarch = aTrierarch(WITH_CODEX);
    trierarch.codex.isFailingLaunch = true;
    const shipId = aCodexShip(trierarch);

    await trierarch.pass();
    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([{ shipId, settingsVersion: 1, reason: `mac-studio: crew failed 3 times: the harness could not start ${shipId}` }]);
    expect(trierarch.state.current().entries).toEqual({});
    expect(trierarch.fleet.shipOf(shipId).status).toBe('awaitingCrew');
  });

  it('counts the failures of a new settings version afresh', async () => {
    const trierarch = aTrierarch(WITH_CODEX);
    trierarch.codex.isFailingLaunch = true;
    const shipId = aCodexShip(trierarch);
    await trierarch.pass();
    await trierarch.pass();
    trierarch.fleet.requestAgain(shipId);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.givenBack).toEqual([]);
  });

  it('tells argo instead when the fleet refuses to take the request back, as for a final crew', async () => {
    const trierarch = aTrierarch(WITH_CODEX);
    trierarch.codex.isFailingLaunch = true;
    trierarch.fleet.isRefusingGiveBack = true;
    const shipId = aCodexShip(trierarch);

    await trierarch.pass();
    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.toArgo.map((report) => report.text)).toEqual([`Cannot crew broken with its settings\n\n- Ship: broken (\`${shipId}\`)\n- Settings version: 1\n- Why: crew failed 3 times: the harness could not start ${shipId}`]);
  });
});

describe('contained access: the crew token stays with the trierarch (decision 0026)', () => {
  it("keeps the ship's crew token in its state, and writes the folder's identity with the ship's socket and no token", async () => {
    const trierarch = aTrierarch();

    const shipId = await aCrewedShip(trierarch);

    expect(trierarch.state.current().entries[shipId]?.crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
    expect(trierarch.harness.identities.get(SCOUT_FOLDER)).not.toHaveProperty('crewToken');
    expect(trierarch.harness.identities.get(SCOUT_FOLDER)?.socket).toBe(InMemoryShipSockets.pathOf(shipId));
  });

  it("opens the ship's socket before its session starts", async () => {
    const trierarch = aTrierarch();

    const shipId = await aCrewedShip(trierarch);

    expect(trierarch.sockets.opens[0]).toEqual({ shipId, launchesBefore: 0 });
    expect(trierarch.sockets.openShips.has(shipId)).toBe(true);
  });

  it('watches the inbox with the crew token in its state', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);

    await trierarch.pass();

    expect(trierarch.fleet.inboxCalls.at(-1)).toBe(trierarch.fleet.shipOf(shipId).crewToken);
  });

  it('opens the socket of each ship it crews again at its next pass after the trierarch stopped, and the session keeps running', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.sockets.stopTrierarch();

    await trierarch.pass();

    expect(trierarch.sockets.openShips.has(shipId)).toBe(true);
    expect(trierarch.harness.launches).toHaveLength(1);
  });

  it('closes the socket and forgets the crew token when the request is removed', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.sockets.openShips.has(shipId)).toBe(false);
    expect(trierarch.state.current().entries[shipId]).toBeUndefined();
  });

  it('keeps the new crew token behind the same socket when the ship is crewed again', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.releaseElsewhere(shipId);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
    expect(trierarch.harness.identities.get(SCOUT_FOLDER)?.socket).toBe(InMemoryShipSockets.pathOf(shipId));
  });
  /** The ship's entry as a trierarch before decision 0026 kept it: its crew token only in the folder's identity, none in the state. */
  async function withoutCrewTokenInState(trierarch: ReturnType<typeof aTrierarch>, shipId: ShipId): Promise<void> {
    const state = trierarch.state.current();
    const entry = state.entries[shipId];
    if (entry !== undefined) {
      const { crewToken, ...older } = entry;
      expect(crewToken).toBeDefined();
      await trierarch.state.save({ ...state, entries: { ...state.entries, [shipId]: older } });
    }
  }

  it.each(['running', 'restarting'] as const)('crews a %s ship again when its entry holds no crew token, in the same folder, without telling argo', async (entryState) => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    const first = trierarch.fleet.shipOf(shipId).crewToken;
    await withoutCrewTokenInState(trierarch, shipId);
    const state = trierarch.state.current();
    const entry = state.entries[shipId];
    if (entry !== undefined && entryState === 'restarting') {
      await trierarch.state.save({ ...state, entries: { ...state.entries, [shipId]: { ...entry, state: 'restarting', restartAt: '2026-10-06T09:00:00.000Z' } } });
    }

    await trierarch.pass();

    const crewToken = trierarch.state.current().entries[shipId]?.crewToken;
    expect(crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
    expect(crewToken).not.toBe(first);
    expect(trierarch.state.current().entries[shipId]?.folder).toBe(SCOUT_FOLDER);
    expect(trierarch.harness.launches).toHaveLength(2);
    expect(trierarch.fleet.toArgo).toEqual([]);
  });
});

describe("trouble the trierarch reports goes to the ship's owner (decision 0045)", () => {
  const THOMAS = { shipId: newId('ship'), name: 'thomas' };
  const crashed = (shipId: ShipId) => `scout crashed ${String(RESTART_BUDGET + 1)} times in an hour\n\n- Ship: scout (\`${shipId}\`)\n- Status: crashed, its restart budget spent`;
  const cannotCrew = (shipId: ShipId) => `Cannot crew scout with its settings\n\n- Ship: scout (\`${shipId}\`)\n- Settings version: 1\n- Why: harness: This trierarch offers no harness codex`;
  const UNREACHABLE = 'Its owner thomas could not be reached: NOT_REACHABLE: no rule lets mac-studio reach thomas.';

  it('sends the crash report to the owner when a person owns the ship, saying argo can restart it, and argo nothing', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.own(shipId, THOMAS);

    await crashForGood(trierarch, shipId);

    expect(trierarch.fleet.toOwners.map(({ ownerShipId, text }) => ({ ownerShipId, text }))).toEqual([{ ownerShipId: THOMAS.shipId, text: `${crashed(shipId)}\n\nargo can restart it in the console.` }]);
    expect(trierarch.fleet.toArgo).toEqual([]);
  });

  it('sends the crash report to argo when argo owns the ship, telling it to restart it', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);

    await crashForGood(trierarch, shipId);

    expect(trierarch.fleet.toArgo.map(({ text }) => text)).toEqual([`${crashed(shipId)}\n\nRestart it in the console to crew it again.`]);
    expect(trierarch.fleet.toOwners).toEqual([]);
  });

  it('sends argo the crash report when the fleet refuses it to the owner, saying the owner could not be reached, and logs it', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.own(shipId, THOMAS);
    trierarch.fleet.isRefusingOwnerReports = true;

    await crashForGood(trierarch, shipId);

    expect(trierarch.fleet.toArgo.map(({ text }) => text)).toEqual([`${crashed(shipId)}\n\nRestart it in the console to crew it again.\n\n${UNREACHABLE}`]);
    expect(trierarch.logger.warnings).toContain(`Could not reach thomas (${THOMAS.shipId}), the owner of scout (${shipId}): NOT_REACHABLE: no rule lets mac-studio reach thomas; argo is told instead`);
  });

  it('sends the owner the notice that it cannot crew settings it cannot give back, once per settings version', async () => {
    const trierarch = aTrierarch();
    trierarch.fleet.isRefusingGiveBack = true;
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings({ harness: 'codex' }));
    trierarch.fleet.own(shipId, THOMAS);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.fleet.toOwners.map(({ ownerShipId, text }) => ({ ownerShipId, text }))).toEqual([{ ownerShipId: THOMAS.shipId, text: cannotCrew(shipId) }]);
    expect(trierarch.fleet.toArgo).toEqual([]);
  });

  it('sends argo that notice when the fleet refuses it to the owner, saying the owner could not be reached', async () => {
    const trierarch = aTrierarch();
    trierarch.fleet.isRefusingGiveBack = true;
    trierarch.fleet.isRefusingOwnerReports = true;
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings({ harness: 'codex' }));
    trierarch.fleet.own(shipId, THOMAS);

    await trierarch.pass();

    expect(trierarch.fleet.toArgo.map(({ text }) => text)).toEqual([`${cannotCrew(shipId)}\n\n${UNREACHABLE}`]);
  });
});

describe('read-only checkouts (#1182)', () => {
  /** aeolus-fleet sessions get governance and skills as read-only checkouts. */
  const WITH_CHECKOUTS = {
    ...CONFIGURATION,
    repositories: {
      'aeolus-fleet': { path: '/home/thomas/Projects/aeolus-fleet', checkouts: ['governance', 'skills'] },
      governance: { path: '/home/thomas/Projects/governance' },
      skills: { path: '/home/thomas/Projects/skills' },
    },
  };
  const checkoutsOf = (shipId: ShipId) => [
    { repository: 'governance', path: InMemoryCheckouts.pathOf(shipId, 'governance') },
    { repository: 'skills', path: InMemoryCheckouts.pathOf(shipId, 'skills') },
  ];

  it("makes the checkouts its repository names and writes each into the folder's identity, for the session's start context", async () => {
    const trierarch = aTrierarch(WITH_CHECKOUTS);

    const shipId = await aCrewedShip(trierarch);

    expect(trierarch.harness.identities.get(SCOUT_FOLDER)).toEqual({
      fleetUrl: 'https://fleet.example.com',
      shipId,
      shipName: 'scout',
      socket: InMemoryShipSockets.pathOf(shipId),
      checkouts: checkoutsOf(shipId),
    });
  });

  it('starts the session with its checkouts', async () => {
    const trierarch = aTrierarch(WITH_CHECKOUTS);

    const shipId = await aCrewedShip(trierarch);

    expect(trierarch.harness.launchedCheckouts).toEqual([{ shipId, checkouts: checkoutsOf(shipId) }]);
  });

  it('starts a session that died again with its checkouts', async () => {
    const trierarch = aTrierarch(WITH_CHECKOUTS);
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.exit(shipId);

    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    expect(trierarch.harness.launchedCheckouts.at(-1)).toEqual({ shipId, checkouts: checkoutsOf(shipId) });
  });

  it('gives a session in a configured folder no checkouts', async () => {
    const trierarch = aTrierarch(WITH_CHECKOUTS);

    const shipId = await aCrewedShip(trierarch, { workspace: { kind: 'folder', name: 'notes' } });

    expect(trierarch.harness.launchedCheckouts).toEqual([{ shipId, checkouts: [] }]);
    expect(trierarch.harness.identities.get(NOTES_FOLDER)).not.toHaveProperty('checkouts');
  });

  it('removes its checkouts when its request is removed', async () => {
    const trierarch = aTrierarch(WITH_CHECKOUTS);
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    expect(trierarch.checkouts.removed).toEqual([shipId]);
  });

  it('removes its checkouts when it gives the request back before its crew is final', async () => {
    const trierarch = aTrierarch(WITH_CHECKOUTS, DETECTED);
    const shipId = await aLaunchedShip(trierarch, { seen: { kind: 'refused', model: 'sonnet' }, settings: { options: { model: 'sonnet' } } });

    await trierarch.pass();

    expect(trierarch.checkouts.removed).toEqual([shipId]);
  });

  it('removes its checkouts when its request is no longer assigned to it', async () => {
    const trierarch = aTrierarch(WITH_CHECKOUTS);
    const shipId = await aCrewedShip(trierarch);
    trierarch.fleet.unassign(shipId);

    await trierarch.pass();

    expect(trierarch.checkouts.removed).toEqual([shipId]);
  });
});
