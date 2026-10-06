import type { ShipId } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { aTrierarch, aWant, CONFIGURATION, NOTES_FOLDER, WORKTREE_ROOT, type Trierarch } from '../../test/support/in-memory.js';
import { RESTART_BUDGET } from './restart-policy.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const SCOUT_FOLDER = `${WORKTREE_ROOT}/aeolus-fleet/scout`;
const WITH_CODEX = { ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } };

/** A ship wanted and crewed by the trierarch: its id. */
async function aCrewedShip(trierarch: Trierarch, want: Record<string, unknown> = {}) {
  const shipId = trierarch.fleet.commission('scout');
  await trierarch.command('want', aWant(shipId, want));
  await trierarch.pass();
  return shipId;
}

describe('the lifecycle of a wanted ship (docs/trierarch.md)', () => {
  it('row 1: a want adds the entry, and starts nothing yet', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');

    await trierarch.command('want', aWant(shipId));

    expect(trierarch.state.current().entries[shipId]?.state).toBe('wanted');
    expect(trierarch.processes.sessions.size).toBe(0);
    expect(trierarch.fleet.shipOf(shipId).status).toBe('awaitingCrew');
  });

  it('row 2: the first crew registers, makes the worktree, writes the identity and starts the session with the first prompt', async () => {
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
    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', folder: SCOUT_FOLDER, shipName: 'scout' });
    expect(trierarch.fleet.sentTo(trierarch.requester, 'running').map((message) => message.payload)).toEqual([{ shipId }]);
  });

  it('row 2: saves the entry as crewing before it registers', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(shipId));
    trierarch.fleet.isLosingRegisterReply = true;

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.state).toBe('crewing');
  });

  it('row 2: passes the squadron to the identity, so the member checks in at its flagship', async () => {
    const trierarch = aTrierarch();

    await aCrewedShip(trierarch, { squadron: 'hemma-feature-a1b2c3' });

    expect(trierarch.harness.identities.get(SCOUT_FOLDER)?.squadron).toBe('hemma-feature-a1b2c3');
  });

  it('row 3: a session that dies starts again in the same folder with the same crew token, after its wait', async () => {
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
  });

  it('row 3: reports on the ship\'s behalf that its session crashed and restarts (gap rule 5)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.exit(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.reports).toEqual([{ crewToken: trierarch.fleet.shipOf(shipId).crewToken, state: 'blocked', note: 'blocked: session crashed, restarting' }]);
  });

  it('row 4: once the restart budget is spent the entry is crashed, its session stopped, the requester notified', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);

    for (let exit = 0; exit <= RESTART_BUDGET; exit += 1) {
      trierarch.processes.exit(shipId);
      await trierarch.pass();
      trierarch.clock.advance(10 * MINUTE_MS);
      await trierarch.pass();
    }

    expect(trierarch.state.current().entries[shipId]?.state).toBe('crashed');
    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.fleet.sentTo(trierarch.requester, 'crashed').map((message) => message.payload)).toEqual([{ shipId, exits: RESTART_BUDGET + 1 }]);
    expect(trierarch.fleet.shipOf(shipId).status).toBe('crewed');
  });

  it('row 4: a crashed ship wanted again starts again in its folder', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    for (let exit = 0; exit <= RESTART_BUDGET; exit += 1) {
      trierarch.processes.exit(shipId);
      await trierarch.pass();
      trierarch.clock.advance(10 * MINUTE_MS);
      await trierarch.pass();
    }

    await trierarch.command('want', aWant(shipId));
    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', exits: [] });
    expect(trierarch.processes.sessions.get(shipId)).toBe('running');
    expect(trierarch.harness.launches.at(-1)).toMatchObject({ folder: SCOUT_FOLDER, isFirstStart: false });
  });

  it('row 5: after the machine restarts the loop starts every wanted ship again, counting no restart', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.processes.restartMachine();

    await trierarch.pass();

    expect(trierarch.processes.sessions.get(shipId)).toBe('running');
    expect(trierarch.state.current().entries[shipId]).toMatchObject({ state: 'running', exits: [] });
    expect(trierarch.fleet.shipOf(shipId).secret).toBe('aeolus_sk_v1_1');
  });

  it('row 6: release stops the session, ends the lease, removes the entry and the clean worktree, and answers released', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);

    const release = await trierarch.command('release', { shipId });
    await trierarch.pass();

    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.fleet.shipOf(shipId).status).toBe('awaitingCrew');
    expect(trierarch.state.current().entries).toEqual({});
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.fleet.sentTo(trierarch.requester, 'released')).toEqual([
      expect.objectContaining({ inReplyTo: release.messageId, payload: { shipId, workspace: 'removed' } }),
    ]);
  });

  it('row 6: release keeps and reports a worktree with changes, and ends the lease all the same (gap rule 4)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);

    await trierarch.command('release', { shipId });
    await trierarch.pass();

    expect(trierarch.fleet.shipOf(shipId).status).toBe('awaitingCrew');
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(true);
    expect(trierarch.harness.identities.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.state.current().kept).toEqual([{ shipId, path: SCOUT_FOLDER }]);
    expect(trierarch.fleet.sentTo(trierarch.requester, 'released')[0]?.payload).toEqual({ shipId, workspace: 'kept', path: SCOUT_FOLDER });
  });

  it('row 6: a kept worktree is reported by describe and list until a release with force clears it (gap rule 1)', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    trierarch.workspace.change(SCOUT_FOLDER);
    await trierarch.command('release', { shipId });
    await trierarch.pass();

    await trierarch.command('list', {});
    await trierarch.command('release', { shipId, force: true });

    expect(trierarch.fleet.sentTo(trierarch.requester, 'listed')[0]?.payload).toMatchObject({ kept: [{ shipId, path: SCOUT_FOLDER }] });
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.state.current().kept).toEqual([]);
  });

  it('row 6: a configured folder is never removed, only its identity', async () => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch, { workspace: { kind: 'folder', name: 'notes' } });

    await trierarch.command('release', { shipId });
    await trierarch.pass();

    expect(trierarch.workspace.folders.has(NOTES_FOLDER)).toBe(true);
    expect(trierarch.harness.identities.has(NOTES_FOLDER)).toBe(false);
    expect(trierarch.state.current().kept).toEqual([]);
  });

  it.each([
    [
      'released elsewhere',
      (trierarch: Trierarch, shipId: ShipId) => {
        trierarch.fleet.releaseElsewhere(shipId);
      },
    ],
    [
      'retired while wanted',
      (trierarch: Trierarch, shipId: ShipId) => {
        trierarch.fleet.retire(shipId);
      },
    ],
  ])('rows 7 and 8: a ship %s is dropped, its session stopped, its requester notified, and never crewed again', async (_label, arrange) => {
    const trierarch = aTrierarch();
    const shipId = await aCrewedShip(trierarch);
    arrange(trierarch, shipId);

    await trierarch.pass();
    await trierarch.pass();

    expect(trierarch.processes.sessions.has(shipId)).toBe(false);
    expect(trierarch.state.current().entries).toEqual({});
    expect(trierarch.workspace.folders.has(SCOUT_FOLDER)).toBe(false);
    expect(trierarch.fleet.sentTo(trierarch.requester, 'leaseEnded').map((message) => message.payload)).toEqual([{ shipId }]);
    expect(trierarch.harness.launches).toHaveLength(1);
  });

  it('row 7: a ship crewed by another session before its first crew is dropped, never taken', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(shipId));
    trierarch.fleet.crewElsewhere(shipId);

    await trierarch.pass();

    expect(trierarch.fleet.shipOf(shipId).crewToken).toBe('aeolus_ct_v1_elsewhere');
    expect(trierarch.fleet.sentTo(trierarch.requester, 'leaseEnded')).toHaveLength(1);
    expect(trierarch.state.current().entries).toEqual({});
  });

  it('row 9: after a lost register reply, the trierarch releases the ship and crews it again (gap rule 3)', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(shipId));
    trierarch.fleet.isLosingRegisterReply = true;
    await trierarch.pass().catch(() => undefined);
    const lostToken = trierarch.fleet.shipOf(shipId).crewToken;

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.state).toBe('running');
    expect(trierarch.fleet.shipOf(shipId).crewToken).not.toBe(lostToken);
    expect(trierarch.harness.identities.get(SCOUT_FOLDER)?.crewToken).toBe(trierarch.fleet.shipOf(shipId).crewToken);
  });

  it('row 9: a half-made worktree of a wanted ship is used when the crew resumes', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(shipId));
    trierarch.workspace.folders.set(SCOUT_FOLDER, { shipId, hasChanges: false });

    await trierarch.pass();

    expect(trierarch.state.current().entries[shipId]?.folder).toBe(SCOUT_FOLDER);
    expect(trierarch.state.current().orphans).toEqual([]);
  });
});

describe('the gaps the loop closes (docs/trierarch.md)', () => {
  it('rule 2: a session of the trierarch with no entry is stopped', async () => {
    const trierarch = aTrierarch();
    const stray = trierarch.fleet.commission('stray');
    trierarch.processes.sessions.set(stray, 'running');

    await trierarch.pass();

    expect(trierarch.processes.sessions.has(stray)).toBe(false);
  });

  it('rule 2: a worktree under its root with no entry is reported as an orphan, never deleted', async () => {
    const trierarch = aTrierarch();
    const orphan = `${WORKTREE_ROOT}/aeolus-fleet/lookout`;
    trierarch.workspace.folders.set(orphan, { hasChanges: false });

    await trierarch.pass();
    await trierarch.command('list', {});

    expect(trierarch.workspace.folders.has(orphan)).toBe(true);
    expect(trierarch.fleet.sentTo(trierarch.requester, 'listed')[0]?.payload).toMatchObject({ orphans: [{ path: orphan }] });
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
    await trierarch.command('want', aWant(first));
    await trierarch.command('want', aWant(second));

    await trierarch.pass();

    expect(trierarch.processes.sessions.size).toBe(1);
    expect(Object.values(trierarch.state.current().entries).map((entry) => entry.state).sort()).toEqual(['running', 'wanted']);
  });

  it('crews a ship with the harness its want names: its identity and its session', async () => {
    const trierarch = aTrierarch(WITH_CODEX);

    await aCrewedShip(trierarch, { harness: 'codex' });

    expect(trierarch.codex.identities.has(SCOUT_FOLDER)).toBe(true);
    expect(trierarch.codex.launches).toHaveLength(1);
    expect(trierarch.harness.launches).toEqual([]);
  });

  it('wakes a ship through the harness its want names, from that harness\'s turn', async () => {
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
    await clean.command('release', { shipId: await aCrewedShip(clean) });
    const changed = aTrierarch();
    const shipId = await aCrewedShip(changed);
    changed.workspace.change(SCOUT_FOLDER);
    await changed.command('release', { shipId });

    await clean.pass();
    await changed.pass();

    expect(logged(clean).at(-1)).toBe('release: released, its worktree removed');
    expect(logged(changed).at(-1)).toBe(`release: released, its worktree kept with changes: ${SCOUT_FOLDER}`);
  });

  it('logs a ship dropped because its lease ended elsewhere', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(shipId));
    trierarch.fleet.crewElsewhere(shipId);

    await trierarch.pass();

    expect(logged(trierarch)).toEqual(['drop: its lease ended elsewhere, so it is no longer crewed here']);
  });

  it('logs a failure with its ship and what happens next, and ends the pass there', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(shipId));
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
