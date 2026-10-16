import { CREW_REQUEST_REASON_MAX_LENGTH, type ShipId } from '@aeolus-fleet/common';

import { putEntry, removeEntry, withState, type Entry, type TrierarchState } from './entry.js';
import { MODEL_OPTION } from './detected-options.js';
import type { FleetPort, HarnessPort, LaunchSeen, LoggedAction, Logger, SessionRuntime, StatePort, TrierarchSetup, TrustPort, WorkspacePort } from './ports.js';
import { HOLDS_IDENTITY, reconcile, writtenStatusOf, type Action, type Observed } from './reconciler.js';
import type { RefuseModel } from './refuse-model.js';
import type { Clock } from './shared/clock.js';

/**
 * Use case: one pass of the trierarch's loop (docs/trierarch.md, "Crewing a
 * ship"). It reads the crew requests assigned to it and sees what runs, lets
 * the Reconciler decide, saves the state the actions start from (an entry
 * crewing is saved before the trierarch registers), then carries the actions
 * out, saving after each one that changes the state. Each action is logged
 * with its ship and outcome. A failed one is logged with what happens next,
 * and fails alone (#827): the pass goes on from the saved state with the
 * next action. A crew that fails 3 times in a row is given back, its last
 * failure the reason, so another trierarch can crew the ship.
 */
export type RunPass = () => Promise<void>;

export interface RunPassDeps {
  fleet: FleetPort;
  /** One adapter per harness the configuration offers, by its name. */
  harnesses: Readonly<Record<string, HarnessPort>>;
  processes: Pick<SessionRuntime, 'list' | 'stop'>;
  workspace: WorkspacePort;
  /** What each harness trusts, read each pass so it is checked before every launch (#381). */
  trust: TrustPort;
  state: StatePort;
  setup: TrierarchSetup;
  clock: Clock;
  logger: Logger;
  /** Keeps a model a session refused as refused, so the machine offers it no more (#382). */
  refuseModel: RefuseModel;
  /** A fresh launch id for each start of a session (#490). */
  newLaunchId: () => string;
}

const NEXT_AFTER_FAILURE = 'the next pass tries again; aeolus-trierarch status and list show where it stands';

/** How many crews of a settings version may fail in a row before the request is given back (#827): the restart budget's count. */
export const CREW_FAILURE_BUDGET = 3;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRunPass(deps: RunPassDeps): RunPass {
  return async () => {
    let state = await deps.state.load();
    let actions: readonly Action[];
    try {
      const requests = await deps.fleet.assignedRequests();
      const clears = await deps.fleet.pendingClears();
      const observed = await observe(state, deps);
      const trusted = await deps.trust.trusted();
      const versions = Object.fromEntries(Object.entries(deps.setup.detected ?? {}).flatMap(([harness, found]) => (found === undefined ? [] : [[harness, found.version]])));
      const marksLaunches = Object.fromEntries(await Promise.all(Object.entries(deps.harnesses).map(async ([harness, port]) => [harness, await port.marksLaunches()] as const)));
      const reconciled = reconcile(state, { requests, clears, observed, now: deps.clock.now(), configuration: deps.setup.configuration, trusted, versions, marksLaunches });
      state = reconciled.state;
      await deps.state.save(state);
      actions = reconciled.actions;
    } catch (error) {
      deps.logger.warn(`The pass failed: ${reasonOf(error)}; ${NEXT_AFTER_FAILURE}`);
      return;
    }
    for (const action of actions) {
      try {
        state = await carryOut(state, { action, deps });
      } catch (error) {
        state = await failed({ action, deps, reason: reasonOf(error) });
      }
    }
  };
}

/**
 * A failed action, logged with what happens next. The pass goes on from the
 * saved state, which holds what the action saved before it failed. A failed
 * crew counts against its settings version: the last one of the budget gives
 * the request back. What fails here is logged too, and left to the next pass.
 */
async function failed(at: { action: Action; deps: RunPassDeps; reason: string }): Promise<TrierarchState> {
  const { action, deps, reason } = at;
  try {
    const state = await deps.state.load();
    if (action.kind === 'argo' || action.kind === 'status' || action.kind === 'refuse') {
      deps.logger.warn(`The pass failed at ${action.kind}: ${reason}; ${NEXT_AFTER_FAILURE}`);
      return state;
    }
    const entry = state.entries[action.shipId];
    if (action.kind !== 'crew' || entry === undefined) {
      log(deps, { ...about(state, { shipId: action.shipId, action: action.kind }), outcome: `failed: ${reason}`, next: NEXT_AFTER_FAILURE });
      return state;
    }
    return await crewFailed(state, { entry, deps, reason });
  } catch (error) {
    deps.logger.warn(`The pass failed after ${action.kind} failed: ${reasonOf(error)}; ${NEXT_AFTER_FAILURE}`);
    return deps.state.load();
  }
}

/** A failed crew, counted against its settings version: the last one of the budget gives the request back (#827). */
async function crewFailed(state: TrierarchState, at: EntryAt & { reason: string }): Promise<TrierarchState> {
  const { entry, deps, reason } = at;
  const crewFailures = (entry.crewFailures ?? 0) + 1;
  const logged = { ...about(state, { shipId: entry.shipId, action: 'crew' }), outcome: `failed: ${reason}` };
  if (crewFailures < CREW_FAILURE_BUDGET) {
    const next = putEntry(state, { ...entry, crewFailures });
    await deps.state.save(next);
    log(deps, { ...logged, next: NEXT_AFTER_FAILURE });
    return next;
  }
  log(deps, { ...logged, next: `failed ${String(CREW_FAILURE_BUDGET)} times in a row, so the trierarch gives it back` });
  const given = `crew failed ${String(CREW_FAILURE_BUDGET)} times: ${reason}`;
  return giveBack(state, { action: { kind: 'giveBack', shipId: entry.shipId, settingsVersion: entry.settingsVersion, reason: given, entry }, deps });
}

/**
 * What runs: the sessions, the worktrees under the root, and for each entry
 * whose session runs (or should, after a restart of the machine) its inbox and
 * turn. An inbox is watched only while its session runs, so last seen still
 * means the session is alive; a crewing one from the moment its session runs (#473).
 */
async function observe(state: TrierarchState, deps: RunPassDeps): Promise<Observed> {
  const sessions = await deps.processes.list();
  const worktrees = await deps.workspace.worktrees();
  const ships: Record<string, Observed['ships'][string]> = {};
  const launches: Record<string, LaunchSeen> = {};
  const withoutIdentity: ShipId[] = [];
  for (const entry of Object.values(state.entries)) {
    const session = sessions.find((each) => each.shipId === entry.shipId);
    const { folder } = entry;
    const harness = harnessOf(entry, deps);
    // A crewing session's launch window (#382), and a final crew's first minute after a restart (#397).
    const { launchId } = entry;
    if ((entry.state === 'crewing' || entry.state === 'running') && entry.launchedAt !== undefined && launchId !== undefined && folder !== undefined && session !== undefined && harness !== undefined) {
      const model = entry.options[MODEL_OPTION];
      launches[entry.shipId] = await harness.launchSeen({ shipId: entry.shipId, folder, launchId, ...(model !== undefined && { model }) });
    }
    const isWatched = (entry.state === 'running' || (entry.state === 'crewing' && session !== undefined)) && session?.status !== 'exited';
    // Its identity is looked at too while the trierarch would report on its behalf, as when its session exits in this pass (#664).
    if ((!isWatched && !HOLDS_IDENTITY.has(entry.state)) || folder === undefined || harness === undefined) {
      continue;
    }
    const crewToken = await harness.crewTokenOf({ shipId: entry.shipId, folder });
    if (crewToken === undefined) {
      withoutIdentity.push(entry.shipId);
      continue;
    }
    if (isWatched) {
      const turn = await harness.turnOf({ shipId: entry.shipId, folder });
      // The store is asked only when a hand-over could follow.
      const isHolding = turn === 'idle' && (await harness.isHolding({ shipId: entry.shipId, folder }));
      ships[entry.shipId] = { inbox: await deps.fleet.inbox(crewToken), turn, isHolding };
    }
  }
  return { sessions, worktrees, ships, launches, withoutIdentity };
}

function log(deps: RunPassDeps, logged: Omit<LoggedAction, 'time'>): void {
  deps.logger.action({ time: deps.clock.now(), ...logged });
}

/** Which ship a log line is about, with its name once the state knows it. */
function about(state: TrierarchState, of: Pick<LoggedAction, 'shipId' | 'action'>): Pick<LoggedAction, 'shipId' | 'shipName' | 'action'> {
  const shipName = state.entries[of.shipId]?.shipName;
  return { ...of, ...(shipName !== undefined && { shipName }) };
}

interface CarryOut {
  readonly action: Action;
  readonly deps: RunPassDeps;
}

async function carryOut(state: TrierarchState, at: CarryOut): Promise<TrierarchState> {
  const { action, deps } = at;
  switch (action.kind) {
    case 'argo':
      await deps.fleet.reportToArgo(action.report);
      return state;
    case 'status':
      await deps.fleet.writeStatus(action.shipId, action.written);
      return state;
    case 'refuse':
      return refuse(state, { action, deps });
    case 'giveBack':
      return giveBack(state, { action, deps });
    case 'modelRefused':
      await modelRefused({ action, deps });
      return state;
    case 'identityGone':
      await identityGone({ action, deps });
      return state;
    case 'confirm':
      await deps.fleet.confirmRelease(action.shipId);
      log(deps, { shipId: action.shipId, action: 'confirm', outcome: 'its request removed; this trierarch did not crew it' });
      return state;
    case 'stop':
      await deps.processes.stop(action.shipId);
      log(deps, { ...about(state, { shipId: action.shipId, action: 'stop' }), outcome: 'its session stopped' });
      return state;
    case 'forget':
      return forget(state, { entry: action.entry, deps });
    case 'release':
      return release(state, { shipId: action.shipId, deps });
    case 'clear':
      return clear(state, { action, deps });
    case 'crew':
    case 'launch':
    case 'wake':
    case 'report':
      return carryOutForEntry(state, { action, deps });
  }
}

async function carryOutForEntry(state: TrierarchState, at: CarryOut & { action: Extract<Action, { kind: 'crew' | 'launch' | 'wake' | 'report' }> }): Promise<TrierarchState> {
  const { action, deps } = at;
  const entry = state.entries[action.shipId];
  if (entry === undefined) {
    return state;
  }
  switch (action.kind) {
    case 'crew':
      return crew(state, { entry, isResumed: action.isResumed, deps });
    case 'launch':
      if (entry.folder !== undefined) {
        const harness = harnessOf(entry, deps);
        // The session that held its messages is gone: its store marks them for the session started now (#756).
        await harness?.sessionDied({ shipId: entry.shipId, folder: entry.folder });
        const launchId = deps.newLaunchId();
        await harness?.launch({
          shipId: entry.shipId,
          // An entry saved before the ship's name was kept goes by its id.
          shipName: entry.shipName ?? entry.shipId,
          folder: entry.folder,
          workspace: entry.workspace,
          harness: entry.harness,
          options: entry.options,
          isFirstStart: false,
          launchId,
        });
        log(deps, { ...about(state, { shipId: entry.shipId, action: 'launch' }), outcome: `started again in ${entry.folder}` });
        // Its first minute is checked from now, while it runs (#397).
        const next = putEntry(state, { ...entry, launchedAt: deps.clock.now().toISOString(), launchId });
        await deps.state.save(next);
        return next;
      }
      return state;
    case 'wake':
      if (entry.folder !== undefined && (await harnessOf(entry, deps)?.handOver({ shipId: entry.shipId, folder: entry.folder })) === 'handed') {
        log(deps, { ...about(state, { shipId: entry.shipId, action: 'wake' }), outcome: 'handed a message over' });
      }
      return state;
    case 'report': {
      const crewToken = entry.folder === undefined ? undefined : await harnessOf(entry, deps)?.crewTokenOf({ shipId: entry.shipId, folder: entry.folder });
      if (crewToken === undefined) {
        // Argo is told by the identityGone action (#664).
        log(deps, { ...about(state, { shipId: entry.shipId, action: 'report' }), outcome: `not reported ${action.note}, as its folder holds no identity` });
        return state;
      }
      await deps.fleet.report({ crewToken, state: 'blocked', note: action.note });
      log(deps, { ...about(state, { shipId: entry.shipId, action: 'report' }), outcome: `reported ${action.note}` });
      return state;
    }
  }
}

interface EntryAt {
  readonly entry: Entry;
  readonly deps: RunPassDeps;
}

/**
 * Crews the ship (crew:run): once its harness can start a session (#827),
 * makes the workspace (or uses the one it has), gets its starting prompt and
 * registers with the secret, so the session never sees it; writes the
 * folder's identity (with its squadron) and starts the harness, writing
 * status crewing: it runs once its session shows activity
 * in its launch window (#382). A resumed crew whose ship is
 * crewed holds the ship by its own lease, or lost its register reply: the
 * trierarch releases the ship and crews it again. A ship another session
 * crews before its crew is left; a ship gone is forgotten.
 */
async function crew(state: TrierarchState, at: EntryAt & { isResumed: boolean }): Promise<TrierarchState> {
  const { entry, isResumed, deps } = at;
  const harness = harnessOf(entry, deps);
  if (harness === undefined) {
    return state;
  }
  const ship = await deps.fleet.ship(entry.shipId);
  if (ship.kind === 'notFound' || ship.kind === 'retired') {
    return forget(state, { entry, deps });
  }
  if (ship.kind === 'crewed' && !isResumed) {
    const next = removeEntry(state, entry.shipId);
    await deps.state.save(next);
    log(deps, { shipId: entry.shipId, shipName: ship.name, action: 'leave', outcome: 'crewed by another session, so the trierarch leaves it' });
    return next;
  }
  if (ship.kind === 'crewed') {
    await deps.fleet.release(entry.shipId);
  }
  let crewing = entry;
  if (entry.isReleasedElsewhere === true) {
    crewing = await freshAfterReleaseElsewhere({ entry, deps });
    state = putEntry(state, crewing);
    await deps.state.save(state);
  }
  await deps.fleet.writeStatus(crewing.shipId, writtenStatusOf(withState(crewing, { state: 'crewing', now: deps.clock.now() })));
  // Registered only once the crew can start, so a crew that cannot never takes the ship's lease (#827).
  const problem = await harness.startProblem();
  if (problem !== undefined) {
    return crewFailed(state, { entry: crewing, deps, reason: problem });
  }
  const { folder } = await deps.workspace.prepare({ shipId: crewing.shipId, shipName: ship.name, workspace: crewing.workspace });
  // Kept at once, so an crewing still crewing knows the workspace and identity to remove if it ends (#382).
  state = putEntry(state, { ...crewing, shipName: ship.name, folder });
  await deps.state.save(state);
  const { secret } = await deps.fleet.getStartingPrompt(crewing.shipId);
  const { crewToken } = await deps.fleet.register({ shipId: crewing.shipId, secret });
  await harness.prepareIdentity({
    folder,
    identity: { fleetUrl: deps.fleet.url, shipId: crewing.shipId, shipName: ship.name, crewToken, ...(crewing.squadron !== undefined && { squadron: crewing.squadron }) },
  });
  const launchId = deps.newLaunchId();
  await harness.launch({
    shipId: crewing.shipId,
    shipName: ship.name,
    folder,
    workspace: crewing.workspace,
    harness: crewing.harness,
    options: crewing.options,
    isFirstStart: !crewing.hasStarted,
    launchId,
    ...(!crewing.hasStarted && crewing.firstPrompt !== undefined && { firstPrompt: crewing.firstPrompt }),
  });
  // Crewing still: its launch window is open, and only activity in it makes the crew final (#382).
  const { crewFailures, ...started } = crewing;
  const next = putEntry(state, { ...(crewFailures === undefined ? crewing : started), shipName: ship.name, folder, hasStarted: true, launchedAt: deps.clock.now().toISOString(), launchId });
  await deps.state.save(next);
  log(deps, { shipId: crewing.shipId, shipName: ship.name, action: 'crew', outcome: `crewed, ${crewing.harness} started in ${folder}` });
  return next;
}

/**
 * A ship released elsewhere is crewed again in a fresh worktree (row 11,
 * #475): before it registers, its workspace goes as a release's does, argo
 * told first what that discards. The entry is saved without its mark only
 * once that is done, so a failed remove tries again on the next pass.
 * Answers the entry it is crewed with.
 */
async function freshAfterReleaseElsewhere(at: EntryAt): Promise<Entry> {
  const { entry, deps } = at;
  const workspace = await releaseWorkspace({ entry, deps, cause: 'releasedElsewhere' });
  log(deps, { ...(entry.shipName !== undefined && { shipName: entry.shipName }), shipId: entry.shipId, action: 'release', outcome: `released elsewhere, ${workspace}` });
  const { isReleasedElsewhere, ...fresh } = entry;
  return isReleasedElsewhere === undefined ? entry : fresh;
}

/**
 * Its request was removed (row 7): the session stops, the lease ends, then
 * the workspace goes (#450); only then does the trierarch confirm, and the
 * request goes.
 */
async function release(state: TrierarchState, at: { shipId: Entry['shipId']; deps: RunPassDeps }): Promise<TrierarchState> {
  const { shipId, deps } = at;
  const entry = state.entries[shipId];
  if (entry === undefined) {
    return state;
  }
  await deps.processes.stop(shipId);
  if ((await deps.fleet.ship(shipId)).kind === 'crewed') {
    await deps.fleet.release(shipId);
  }
  const workspace = await releaseWorkspace({ entry, deps, cause: 'release' });
  const next = removeEntry(state, shipId);
  await deps.state.save(next);
  await deps.fleet.confirmRelease(shipId);
  log(deps, { ...about(state, { shipId, action: 'release' }), outcome: `released, ${workspace}` });
  return next;
}

/**
 * The workspace of a released entry (row 7, #450): its identity goes, and a
 * worktree the trierarch made is removed whatever it holds, so the next crew
 * starts from a fresh one. What that discards is told to argo first, once per
 * release; a failed remove tries again on the next pass. A configured folder
 * is never removed. Answers what became of it, as the log line says it.
 */
async function releaseWorkspace(at: EntryAt & { cause: ReleaseCause }): Promise<string> {
  const { entry, deps, cause } = at;
  const { folder } = entry;
  if (folder === undefined) {
    return 'its worktree removed';
  }
  await harnessOf(entry, deps)?.removeIdentity({ shipId: entry.shipId, folder });
  if (entry.workspace.kind === 'folder') {
    return `its folder kept: ${folder}`;
  }
  const unsaved = await deps.workspace.unsaved(folder);
  if (unsaved.length > 0) {
    const machine = await deps.fleet.whoami();
    await deps.fleet.reportToArgo({
      text: discardedText(`${machine.name}: ${removedBecause(entry, { cause, repository: entry.workspace.repository })}, discarding what was not pushed: `, unsaved),
      idempotencyKey: `trierarch:discarded:${entry.shipId}:${entry.since}`,
    });
  }
  await deps.workspace.remove(folder);
  if (unsaved.length === 0) {
    return 'its worktree removed';
  }
  return `its worktree removed, discarding ${String(unsaved.length)} unpushed ${unsaved.length === 1 ? 'change' : 'changes'}, told to argo`;
}

/**
 * A clear request (decision 0032): the kept worktree it names is removed
 * (the workspace removes only one under the root) and dropped from the state,
 * saved, then the request is confirmed removed. With none kept, it is
 * confirmed not-kept. A failed remove leaves both for the next pass; a lost
 * confirmation is confirmed not-kept on the next one.
 */
async function clear(state: TrierarchState, at: CarryOut & { action: Extract<Action, { kind: 'clear' }> }): Promise<TrierarchState> {
  const { action, deps } = at;
  const { shipId, repository, kept } = action;
  if (kept === undefined) {
    await deps.fleet.confirmCleared({ shipId, repository, outcome: 'not-kept' });
    log(deps, { shipId, action: 'clear', outcome: `no kept ${repository} worktree of it here` });
    return state;
  }
  await deps.workspace.remove(kept.path);
  const next = { ...state, kept: state.kept.filter((each) => each.path !== kept.path) };
  await deps.state.save(next);
  await deps.fleet.confirmCleared({ shipId, repository, outcome: 'removed' });
  log(deps, { shipId, action: 'clear', outcome: `its kept worktree removed: ${kept.path}` });
  return next;
}

/**
 * Its request is no longer assigned here, as when its ship is retired (gap
 * rule 2): the session stops and its identity goes, but nothing the trierarch
 * cannot tell is clean goes: its worktree stays, reported as an orphan.
 */
async function forget(state: TrierarchState, at: EntryAt): Promise<TrierarchState> {
  const { entry, deps } = at;
  await deps.processes.stop(entry.shipId);
  if (entry.folder !== undefined) {
    await harnessOf(entry, deps)?.removeIdentity({ shipId: entry.shipId, folder: entry.folder });
  }
  const next = removeEntry(state, entry.shipId);
  await deps.state.save(next);
  log(deps, { shipId: entry.shipId, ...(entry.shipName !== undefined && { shipName: entry.shipName }), action: 'forget', outcome: 'its request is no longer assigned here, so its session stopped' });
  return next;
}

/**
 * Gives back a request whose settings this trierarch cannot crew while its
 * crew is not final (#382): an entry it crewed with ends first (its session
 * stops, its identity goes, its worktree too when clean), then the fleet
 * takes the request back, with the reason after this machine's name, cut to
 * 200 characters, and ends the lease. When the fleet refuses, argo is told
 * instead, once per settings version.
 */
async function giveBack(state: TrierarchState, at: CarryOut & { action: Extract<Action, { kind: 'giveBack' }> }): Promise<TrierarchState> {
  const { action, deps } = at;
  const { shipId, settingsVersion, entry } = action;
  let next = state;
  if (entry !== undefined) {
    await deps.processes.stop(shipId);
    next = removeEntry(await finishWorkspace(state, { entry, deps }), shipId);
    await deps.state.save(next);
  }
  const machine = await deps.fleet.whoami();
  const reason = `${machine.name}: ${action.reason}`.slice(0, CREW_REQUEST_REASON_MAX_LENGTH);
  const answer = await deps.fleet.giveBack(shipId, { settingsVersion, reason });
  if (answer.kind === 'refused') {
    deps.logger.warn(`The fleet refused to take back the crew request of ${shipId}: ${answer.code}: ${answer.message}`);
    return refuse(next, { action: { kind: 'refuse', shipId, settingsVersion, refusal: { reason: action.reason } }, deps });
  }
  log(deps, { shipId, ...(entry?.shipName !== undefined && { shipName: entry.shipName }), action: 'giveBack', outcome: `given back: ${reason}` });
  return next;
}

/**
 * A session refused the model it launched with (#382): the model is kept
 * refused at its harness's version, so this machine offers it no more, and
 * argo is told once per harness, version and model, as the machine and its
 * harness are where to look.
 */
async function modelRefused(at: CarryOut & { action: Extract<Action, { kind: 'modelRefused' }> }): Promise<void> {
  const { action, deps } = at;
  const { shipId, shipName, harness, version, model } = action;
  await deps.refuseModel({ harness, id: model, at: deps.clock.now() });
  const machine = await deps.fleet.whoami();
  await deps.fleet.reportToArgo({
    text: `${machine.name}: ${harness} ${version} refused the model ${model} for ${shipName ?? shipId} (${shipId}): this machine offers it no more at this version, until aeolus-trierarch detect runs by hand`,
    idempotencyKey: `trierarch:refused-model:${harness}:${version}:${model}`,
  });
  log(deps, { shipId, ...(shipName !== undefined && { shipName }), action: 'modelRefused', outcome: `${harness} ${version} refused ${model}, offered no more at this version` });
}

/**
 * A ship's folder holds no identity (#659, #664): the trierarch cannot report
 * on its behalf or see its inbox, so nothing wakes it while its lease still
 * holds. Argo is told, naming the machine and the ship, as only a crew again
 * recovers it.
 */
async function identityGone(at: CarryOut & { action: Extract<Action, { kind: 'identityGone' }> }): Promise<void> {
  const { action, deps } = at;
  const { shipId, shipName } = action;
  const machine = await deps.fleet.whoami();
  await deps.fleet.reportToArgo({
    text: `${machine.name}: ${shipName ?? shipId} (${shipId}): its folder holds no identity, so the trierarch can no longer report on its behalf, watch its inbox or wake it. Restart it in the console to crew it again.`,
    idempotencyKey: `trierarch:identity-gone:${shipId}:${deps.clock.now().toISOString()}`,
  });
  log(deps, { shipId, ...(shipName !== undefined && { shipName }), action: 'identityGone', outcome: 'its folder holds no identity, so it is no longer woken; argo told' });
}

/** Tells argo, once per settings version, that this trierarch cannot crew them. */
async function refuse(state: TrierarchState, at: CarryOut & { action: Extract<Action, { kind: 'refuse' }> }): Promise<TrierarchState> {
  const { action, deps } = at;
  const ship = await deps.fleet.ship(action.shipId);
  const name = ship.kind === 'awaitingCrew' || ship.kind === 'crewed' ? ship.name : action.shipId;
  const { field, reason } = action.refusal;
  await deps.fleet.reportToArgo({
    text: `${name} (${action.shipId}): this trierarch cannot crew settings version ${String(action.settingsVersion)}: ${field === undefined ? reason : `${field}: ${reason}`}`,
    idempotencyKey: `trierarch:refused:${action.shipId}:${String(action.settingsVersion)}`,
  });
  const next = { ...state, refused: { ...state.refused, [action.shipId]: action.settingsVersion } };
  await deps.state.save(next);
  deps.logger.warn(`Cannot crew ${name} (${action.shipId}), settings version ${String(action.settingsVersion)}: ${reason}`);
  return next;
}

/** Why a worktree is removed whatever it holds: its request was removed (row 7), or its ship released elsewhere is crewed again (row 11). */
type ReleaseCause = 'release' | 'releasedElsewhere';

/** What argo is told was removed, and why, before the list of what that discards. */
function removedBecause(entry: Entry, at: { cause: ReleaseCause; repository: string }): string {
  const ship = `${entry.shipName ?? entry.shipId} (${entry.shipId})`;
  const worktree = `its ${at.repository} worktree`;
  switch (at.cause) {
    case 'release':
      return `released ${ship} and removed ${worktree}`;
    case 'releasedElsewhere':
      return `${ship} was released elsewhere, so the trierarch removed ${worktree} before crewing it again`;
  }
}

/** At most this many characters tell argo what a release discards, so the report is always small enough to send. */
const DISCARDED_TEXT_MAX_LENGTH = 4000;

/** The heading, then as many of the discarded lines as fit, then how many more. */
function discardedText(heading: string, unsaved: readonly string[]): string {
  const whole = heading + unsaved.join('; ');
  if (whole.length <= DISCARDED_TEXT_MAX_LENGTH) {
    return whole;
  }
  const named: string[] = [];
  const textOf = (rest: number): string => heading + [...named, `and ${String(rest)} more`].join('; ');
  for (const line of unsaved) {
    named.push(line);
    if (textOf(unsaved.length - named.length).length > DISCARDED_TEXT_MAX_LENGTH) {
      named.pop();
      break;
    }
  }
  return textOf(unsaved.length - named.length);
}

/**
 * The workspace of an entry given back while its crew is not final: a
 * worktree the trierarch made is removed when clean, and kept and reported
 * when not; a configured folder is never removed. The identity goes either way.
 */
async function finishWorkspace(state: TrierarchState, at: EntryAt): Promise<TrierarchState> {
  const { entry, deps } = at;
  const { folder } = entry;
  if (folder === undefined) {
    return state;
  }
  await harnessOf(entry, deps)?.removeIdentity({ shipId: entry.shipId, folder });
  if (entry.workspace.kind === 'folder') {
    return state;
  }
  if (await deps.workspace.isClean(folder)) {
    await deps.workspace.remove(folder);
    return state;
  }
  deps.logger.warn(`Kept the worktree of ${entry.shipId}, which has changes: ${folder}`);
  return { ...state, kept: [...state.kept, { shipId: entry.shipId, repository: entry.workspace.repository, path: folder }] };
}


/**
 * The adapter of the entry's harness. Settings name only a harness the
 * configuration offers, and the trierarch starts with an adapter for each, so
 * none missing is a setup gone wrong: logged, and the entry left as it is.
 */
function harnessOf(entry: Entry, deps: RunPassDeps): HarnessPort | undefined {
  const harness = deps.harnesses[entry.harness];
  if (harness === undefined) {
    deps.logger.warn(`No adapter for the harness ${entry.harness} of ${entry.shipId}`);
  }
  return harness;
}
