import { putEntry, removeEntry, withState, type Entry, type Outgoing, type TrierarchState } from './entry.js';
import type { FleetPort, HarnessPort, Logger, ProcessPort, StatePort, TrierarchSetup, WorkspacePort } from './ports.js';
import { reconcile, type Action, type Observed } from './reconciler.js';
import type { Clock } from './shared/clock.js';

/**
 * Use case: one pass of the trierarch's loop (docs/trierarch.md). It sees
 * what runs, lets the Reconciler decide, saves the state the actions start
 * from (an entry crewing is saved before the trierarch registers), then
 * carries the actions out, saving after each one that changes the list.
 */
export type RunPass = () => Promise<void>;

export interface RunPassDeps {
  fleet: FleetPort;
  harness: HarnessPort;
  processes: ProcessPort;
  workspace: WorkspacePort;
  state: StatePort;
  setup: TrierarchSetup;
  clock: Clock;
  logger: Logger;
}

export function createRunPass(deps: RunPassDeps): RunPass {
  return async () => {
    const loaded = await deps.state.load();
    const observed = await observe(loaded, deps);
    const reconciled = reconcile(loaded, { observed, now: deps.clock.now(), configuration: deps.setup.configuration });
    let state = reconciled.state;
    await deps.state.save(state);
    for (const action of reconciled.actions) {
      state = await carryOut(state, { action, deps });
    }
  };
}

/**
 * What runs: the sessions, the worktrees under the root, and for each entry
 * whose session runs (or should, after a restart of the machine) its inbox and
 * turn. An inbox is watched only while its session runs, so last seen still
 * means the session is alive.
 */
async function observe(state: TrierarchState, deps: RunPassDeps): Promise<Observed> {
  const sessions = await deps.processes.list();
  const worktrees = await deps.workspace.worktrees();
  const ships: Record<string, Observed['ships'][string]> = {};
  for (const entry of Object.values(state.entries)) {
    const session = sessions.find((each) => each.shipId === entry.shipId);
    const { folder } = entry;
    if (entry.state !== 'running' || folder === undefined || session?.status === 'exited') {
      continue;
    }
    const crewToken = await deps.harness.crewTokenOf(folder);
    if (crewToken !== undefined) {
      ships[entry.shipId] = { inbox: await deps.fleet.inbox(crewToken), turn: await deps.harness.turnOf(folder) };
    }
  }
  return { sessions, worktrees, ships };
}

interface CarryOut {
  readonly action: Action;
  readonly deps: RunPassDeps;
}

async function carryOut(state: TrierarchState, at: CarryOut): Promise<TrierarchState> {
  const { action, deps } = at;
  if (action.kind === 'notify') {
    await deps.fleet.send(action.message);
    return state;
  }
  if (action.kind === 'stop') {
    await deps.processes.stop(action.shipId);
    return state;
  }
  const entry = state.entries[action.shipId];
  if (entry === undefined) {
    return state;
  }
  switch (action.kind) {
    case 'crew':
      return crew(state, { entry, isResumed: action.isResumed, deps });
    case 'launch':
      if (entry.folder !== undefined) {
        await deps.harness.launch({ shipId: entry.shipId, folder: entry.folder, harness: entry.harness, options: entry.options, isFirstStart: false });
      }
      return state;
    case 'wake':
      if (entry.folder !== undefined) {
        await deps.harness.wake({ shipId: entry.shipId, folder: entry.folder });
      }
      return state;
    case 'report': {
      const crewToken = entry.folder === undefined ? undefined : await deps.harness.crewTokenOf(entry.folder);
      if (crewToken !== undefined) {
        await deps.fleet.report({ crewToken, state: 'blocked', note: action.note });
      }
      return state;
    }
    case 'release':
      return release(state, { entry, deps });
    case 'drop':
      return drop(state, { entry, deps });
  }
}

interface EntryAt {
  readonly entry: Entry;
  readonly deps: RunPassDeps;
}

/**
 * Crews the ship: gets its starting prompt (fleet:crew) and registers with the
 * secret, so the session never sees it; makes the workspace, writes the
 * folder's identity (with its squadron) and starts the harness. A resumed crew
 * whose ship is crewed lost its register reply: the trierarch releases the
 * ship and crews it again. A ship crewed by another session meanwhile, or gone,
 * is dropped.
 */
async function crew(state: TrierarchState, at: EntryAt & { isResumed: boolean }): Promise<TrierarchState> {
  const { entry, isResumed, deps } = at;
  const ship = await deps.fleet.ship(entry.shipId);
  if (ship.kind === 'notFound' || ship.kind === 'retired' || (ship.kind === 'crewed' && !isResumed)) {
    return drop(state, { entry, deps });
  }
  if (ship.kind === 'crewed') {
    await deps.fleet.release(entry.shipId);
  }
  const { secret } = await deps.fleet.getStartingPrompt(entry.shipId);
  const { crewToken } = await deps.fleet.register({ shipId: entry.shipId, secret });
  const { folder } = await deps.workspace.prepare({ shipId: entry.shipId, shipName: ship.name, workspace: entry.workspace });
  await deps.harness.prepareIdentity({
    folder,
    identity: { fleetUrl: deps.fleet.url, shipId: entry.shipId, shipName: ship.name, crewToken, ...(entry.squadron !== undefined && { squadron: entry.squadron }) },
  });
  await deps.harness.launch({
    shipId: entry.shipId,
    folder,
    harness: entry.harness,
    options: entry.options,
    isFirstStart: !entry.hasStarted,
    ...(!entry.hasStarted && entry.firstPrompt !== undefined && { firstPrompt: entry.firstPrompt }),
  });
  const now = deps.clock.now();
  const next = putEntry(state, { ...withState(entry, { state: 'running', now }), folder, hasStarted: true });
  await deps.state.save(next);
  await deps.fleet.send(notice(entry, { name: 'running', now }));
  return next;
}

/** Release asked by a message: the lease ends whatever the worktree holds, then the workspace, then the answer. */
async function release(state: TrierarchState, at: EntryAt): Promise<TrierarchState> {
  const { entry, deps } = at;
  await deps.processes.stop(entry.shipId);
  await deps.fleet.release(entry.shipId);
  const finished = await finishWorkspace(state, { entry, deps, isForced: entry.release?.isForced ?? false });
  const next = removeEntry(finished.state, entry.shipId);
  await deps.state.save(next);
  if (entry.release !== undefined) {
    const { messageId, sender } = entry.release;
    await deps.fleet.send({
      to: sender,
      inReplyTo: messageId,
      name: 'released',
      payload: { shipId: entry.shipId, workspace: finished.workspace, ...(finished.path !== undefined && { path: finished.path }) },
      idempotencyKey: `trierarch:${messageId}:released`,
    });
  }
  return next;
}

/** The lease ended elsewhere (released, re-crewed or retired): never crewed again, its requester told. */
async function drop(state: TrierarchState, at: EntryAt): Promise<TrierarchState> {
  const { entry, deps } = at;
  await deps.processes.stop(entry.shipId);
  const finished = await finishWorkspace(state, { entry, deps, isForced: false });
  const next = removeEntry(finished.state, entry.shipId);
  await deps.state.save(next);
  await deps.fleet.send(notice(entry, { name: 'leaseEnded', now: deps.clock.now() }));
  return next;
}

/**
 * The workspace of an entry that ends: a worktree the trierarch made is
 * removed when clean (or forced), and kept and reported when not; a
 * configured folder is never removed. The identity goes either way.
 */
async function finishWorkspace(
  state: TrierarchState,
  at: EntryAt & { isForced: boolean },
): Promise<{ state: TrierarchState; workspace: 'removed' | 'kept'; path?: string }> {
  const { entry, deps, isForced } = at;
  const { folder } = entry;
  if (folder === undefined) {
    return { state, workspace: 'removed' };
  }
  await deps.harness.removeIdentity(folder);
  if (entry.workspace.kind === 'folder') {
    return { state, workspace: 'kept', path: folder };
  }
  if (isForced || (await deps.workspace.isClean(folder))) {
    await deps.workspace.remove(folder);
    return { state, workspace: 'removed' };
  }
  deps.logger.warn(`Kept the worktree of ${entry.shipId}, which has changes: ${folder}`);
  return { state: { ...state, kept: [...state.kept, { shipId: entry.shipId, path: folder }] }, workspace: 'kept', path: folder };
}

function notice(entry: Entry, at: { name: 'running' | 'leaseEnded'; now: Date }): Outgoing {
  return { to: entry.requester, name: at.name, payload: { shipId: entry.shipId }, idempotencyKey: `trierarch:${at.name}:${entry.shipId}:${at.now.toISOString()}` };
}
