import { CREW_REQUEST_REASON_MAX_LENGTH, type ShipId } from '@aeolus-fleet/common';

import { putEntry, removeEntry, withState, type Entry, type TrierarchState } from './entry.js';
import { crashText, identityGoneText, keyNotReadyText, leftInTrashText, modelRefusedText, ownerUnreachableText, settingsRefusedText, stoppedOfferingText } from './argo-reports.js';
import { MODEL_OPTION } from './detected-options.js';
import { countStart, PROBE_AFTER_MINUTES, withConfiguration, type StartOutcome } from './failed-starts.js';
import { loginOf, startedOn, type KeyState, type Login, type Logins } from './login.js';
import type { Checkout, CheckoutsPort, FleetPort, FolderProcessesPort, HarnessPort, HarnessSession, LaunchSeen, LeftInTrash, LoggedAction, Logger, ModelLoginsPort, SessionActivity, SessionRuntime, ShipSocketsPort, StatePort, TrashPort, TrierarchSetup, TrustPort, WorkspacePort } from './ports.js';
import { HOLDS_IDENTITY, keepsShipFolder, reconcile, writtenStatusOf, type Action, type Observed } from './reconciler.js';
import type { RefuseModel } from './refuse-model.js';
import type { SendReleasedUsage } from './send-usage.js';
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
  /** What still runs in a worktree, stopped before it is removed: an orphan's (#1041), and one whose crew ended (gap rule 1). */
  folderProcesses: FolderProcessesPort;
  workspace: WorkspacePort;
  /** Each ship's read-only checkouts (#1182), made before its session starts and removed with its identity. */
  checkouts: CheckoutsPort;
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
  /** The ships' sockets its sessions call the fleet over (decision 0026). */
  sockets: ShipSocketsPort;
  /** Which login each session runs on, as the configuration gives it (api keys K5); every session on its subscription without. */
  logins?: Logins;
  /** Whether a session can start on its login now (api keys K9). */
  modelLogins: ModelLoginsPort;
  /** Sends a released ship's last usage before its folder goes (the usage design, U9); rejects while the fleet does not take it. */
  sendReleasedUsage: SendReleasedUsage;
  /** The trash a released clone and ship's home go aside to, emptied every pass; none empties nothing. */
  trash?: TrashPort;
}

const NEXT_AFTER_FAILURE = 'the next pass tries again; aeolus-trierarch status and list show where it stands';

/** The interval the trierarch states with the activity it writes each pass: the fleet reads it as unknown past twice this, a pass being 5 seconds and a slow one a few more. */
export const ACTIVITY_INTERVAL_SECONDS = 30;

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
      // Before anything reads a session through its plugin: a harness whose plugin is gone is left unread (#1212).
      const { marksLaunches, missingPlugins, notOffered } = await launchMarks(deps);
      const observed = await observe(state, { deps, missingPlugins });
      const trusted = await deps.trust.trusted();
      const versions = Object.fromEntries(Object.entries(deps.setup.detected ?? {}).flatMap(([harness, found]) => (found === undefined ? [] : [[harness, found.version]])));
      const reconciled = reconcile(state, { requests, clears, observed, now: deps.clock.now(), configuration: deps.setup.configuration, trusted, versions, marksLaunches, missingPlugins, notOffered });
      const counted = countStarts(succeeded(reconciled.state, { missingPlugins, notOffered }), { outcomes: reconciled.outcomes, deps });
      state = counted.state;
      await deps.state.save(state);
      await tellStopped(state, { isNewlyStopped: counted.isNewlyStopped, deps });
      state = await tellKeysNotReady(state, deps);
      actions = reconciled.actions;
    } catch (error) {
      deps.logger.warn(`The pass failed: ${reasonOf(error)}; ${NEXT_AFTER_FAILURE}`);
      await deps.state.save({ ...state, passFailure: { reason: reasonOf(error), since: state.passFailure?.since ?? deps.clock.now().toISOString() } });
      // The prune and the branch deletion need neither the fleet nor the reconcile, so a failed pass does them too.
      await tidyRepositories(deps);
      return;
    }
    for (const action of actions) {
      try {
        state = await carryOut(state, { action, deps });
      } catch (error) {
        state = await failed({ action, deps, reason: reasonOf(error) });
      }
    }
    await tidyRepositories(deps);
    await emptyTrash(deps);
    await writeActivities(state, deps);
  };
}

/**
 * In each configured repository, drops the git records of worktrees whose folder is gone, then deletes the local branches checked out
 * nowhere whose remote branch is gone: a branch a removed worktree had is checked out nowhere only once its record is gone. A step that
 * fails is logged and fails neither the pass nor the other steps.
 */
async function tidyRepositories(deps: RunPassDeps): Promise<void> {
  for (const repository of Object.keys(deps.setup.configuration.repositories)) {
    try {
      await deps.workspace.prune(repository);
    } catch (error) {
      deps.logger.warn(`Could not prune the worktree records of ${repository}: ${reasonOf(error)}; the next pass tries again`);
    }
    try {
      await deps.workspace.deleteBranchesWhoseRemoteBranchIsGone(repository);
    } catch (error) {
      deps.logger.warn(`Could not delete the local branches whose remote branch is gone in ${repository}: ${reasonOf(error)}; the next pass tries again`);
    }
  }
}

/** How long the trash tries to remove a folder before argo is told it cannot. */
const TRASH_TOLD_AFTER_MS = 24 * 60 * 60 * 1000;

/** Empties the trash: what it cannot remove is logged the first time, and argo told once after a day. It never fails the pass. */
async function emptyTrash(deps: RunPassDeps): Promise<void> {
  if (deps.trash === undefined) {
    return;
  }
  let left: readonly LeftInTrash[];
  try {
    left = await deps.trash.empty();
  } catch (error) {
    deps.logger.warn(`The trash was not emptied: ${reasonOf(error)}; the next pass tries again`);
    return;
  }
  for (const each of left) {
    if (each.isNew) {
      deps.logger.warn(`Could not remove ${each.folder}, in the trash at ${each.path}: ${each.why}; every pass tries again`);
    }
    if (each.isTold || deps.clock.now().getTime() - each.trashedAt.getTime() < TRASH_TOLD_AFTER_MS) {
      continue;
    }
    try {
      await deps.fleet.reportToArgo({ text: leftInTrashText(each), idempotencyKey: `trierarch:trash:${each.pathHash}` });
    } catch (error) {
      deps.logger.warn(`Argo was not told ${each.folder} stays in the trash: ${reasonOf(error)}; the next pass tries again`);
      continue;
    }
    await deps.trash.markTold(each.path).catch((error: unknown) => {
      deps.logger.warn(`Argo was told ${each.folder} stays in the trash, but it was not marked told: ${reasonOf(error)}`);
    });
  }
}

/**
 * Writes the activity of every running session, each pass (monitoring W3b):
 * the fleet reads it as unknown once a write is older than twice the interval
 * stated with it, so a trierarch that is down reads as unknown, not as stopped
 * work. A failure here is told and left: it never fails the pass.
 */
async function writeActivities(state: TrierarchState, deps: RunPassDeps): Promise<void> {
  try {
    const sessions = await deps.processes.list();
    const activities: ({ shipId: ShipId } & SessionActivity)[] = [];
    for (const entry of Object.values(state.entries)) {
      const { folder } = entry;
      const harness = harnessOf(entry, deps);
      if (entry.state !== 'running' || folder === undefined || harness === undefined || sessions.find((each) => each.shipId === entry.shipId)?.status !== 'running') {
        continue;
      }
      const activity = await harness.activityOf(sessionOf(entry, folder));
      if (activity !== undefined) {
        activities.push({ shipId: entry.shipId, ...activity });
      }
    }
    if (activities.length > 0) {
      await deps.fleet.reportActivity({ intervalSeconds: ACTIVITY_INTERVAL_SECONDS, activities });
    }
  } catch (error) {
    deps.logger.warn(`The activity of the sessions was not written: ${reasonOf(error)}; the next pass tries again`);
  }
}

/** Whether each harness's aeolus-fleet plugin marks launches, which harnesses have no plugin to ask (#1212), one missing never failing the pass for the others, and why the machine does not offer a harness (CC3, CC10). */
async function launchMarks(deps: RunPassDeps): Promise<{ marksLaunches: Record<string, boolean>; missingPlugins: Set<string>; notOffered: Record<string, string> }> {
  const marksLaunches: Record<string, boolean> = {};
  const missingPlugins = new Set<string>();
  const notOffered: Record<string, string> = {};
  await Promise.all(
    Object.entries(deps.harnesses).map(async ([harness, port]) => {
      const reason = await port.notOfferedReason();
      if (reason !== undefined) {
        notOffered[harness] = reason;
      }
      try {
        marksLaunches[harness] = await port.marksLaunches();
      } catch (error) {
        missingPlugins.add(harness);
        deps.logger.warn(`The aeolus-fleet plugin for ${harness} cannot be used: ${reasonOf(error)}; its requests are given back until it is installed (aeolus-trierarch upgrade)`);
      }
    }),
  );
  return { marksLaunches, missingPlugins, notOffered };
}

/** The state of a pass that succeeded: no failing pass is kept, the harnesses whose plugin it could not find (#1212), and those not offered, with why (CC3). */
function succeeded(state: TrierarchState, at: { missingPlugins: ReadonlySet<string>; notOffered: Readonly<Record<string, string>> }): TrierarchState {
  const { missingPlugins } = at;
  const notOffered = Object.entries(at.notOffered)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([harness, reason]) => ({ harness, reason }));
  // Every other field of the state (what the machine is low on, #400) stays as the pass found it.
  return { ...state, passFailure: undefined, missingPlugins: missingPlugins.size > 0 ? [...missingPlugins].sort() : undefined, notOffered: notOffered.length > 0 ? notOffered : undefined };
}

/**
 * The machine's failed starts after this pass's (#853): a trierarch started
 * with another configuration than it stopped with counts afresh, then each
 * launch window that closed is counted in turn. Answers whether they stopped
 * the machine offering itself now, so argo is told once.
 */
function countStarts(state: TrierarchState, at: { outcomes: readonly StartOutcome[]; deps: RunPassDeps }): { state: TrierarchState; isNewlyStopped: boolean } {
  const { outcomes, deps } = at;
  const configuration = configurationOf(deps);
  let failedStarts = withConfiguration(state.failedStarts, configuration);
  let isNewlyStopped = false;
  for (const outcome of outcomes) {
    const counted = countStart(failedStarts, { outcome, now: deps.clock.now(), configuration });
    failedStarts = counted.failedStarts;
    isNewlyStopped ||= counted.isNewlyStopped;
  }
  return { state: { ...state, failedStarts }, isNewlyStopped };
}

/** The configuration as its file gives it, as a failed start keeps it: another one offers the machine again (#853). */
function configurationOf(deps: RunPassDeps): string {
  return JSON.stringify(deps.setup.configured);
}

/** Tells argo, once per stop, that the machine stopped offering itself, with the first reason (#853); a failure to tell is logged, and the pass goes on. */
async function tellStopped(state: TrierarchState, at: { isNewlyStopped: boolean; deps: RunPassDeps }): Promise<void> {
  const { isNewlyStopped, deps } = at;
  const { failedStarts } = state;
  if (!isNewlyStopped || failedStarts?.stopped === undefined) {
    return;
  }
  deps.logger.warn(`The machine stops offering itself: the starts of ${String(failedStarts.shipIds.length)} ships failed in a row, first: ${failedStarts.reason}; it offers itself again ${String(PROBE_AFTER_MINUTES)} minutes after its last failed start`);
  try {
    await deps.fleet.reportToArgo({ text: stoppedOfferingText(failedStarts), idempotencyKey: `trierarch:stopped-offering:${failedStarts.stopped.since}` });
  } catch (error) {
    deps.logger.warn(`Could not tell argo the machine stopped offering itself: ${reasonOf(error)}`);
  }
}

/**
 * Tells argo once per harness and state of its API key while ships on it wait
 * (api keys K9): the harness, the state since when and those ships. A key
 * ready again is forgotten, so a later state is told again; a key no ship
 * here is on is nobody's concern. A failure to tell is logged and tried again
 * on the next pass.
 */
async function tellKeysNotReady(state: TrierarchState, deps: RunPassDeps): Promise<TrierarchState> {
  const onKey = Object.values(state.entries).filter((entry) => (entry.login ?? sessionLogin(entry, deps)) === 'apiKey');
  const harnesses = [...new Set(onKey.map((entry) => entry.harness))].sort();
  const told: Record<string, KeyState> = {};
  for (const harness of harnesses) {
    const key = await deps.modelLogins.keyState(harness);
    if (key.state === 'ready') {
      continue;
    }
    if (state.keysTold?.[harness] === key.state) {
      told[harness] = key.state;
      continue;
    }
    const ships = onKey.filter((entry) => entry.harness === harness);
    try {
      await deps.fleet.reportToArgo({ text: keyNotReadyText({ harness, key, ships }), idempotencyKey: `trierarch:key:${harness}:${key.state}:${key.at ?? ''}` });
      told[harness] = key.state;
    } catch (error) {
      deps.logger.warn(`Could not tell argo that ${harness}'s API key is not ready: ${reasonOf(error)}`);
    }
  }
  const next: TrierarchState = { ...state, keysTold: Object.keys(told).length > 0 ? told : undefined };
  if (JSON.stringify(next.keysTold ?? {}) !== JSON.stringify(state.keysTold ?? {})) {
    await deps.state.save(next);
  }
  return next;
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
    if (action.kind === 'removeStray') {
      deps.logger.warn(`Could not remove ${action.folder}, a folder under the root no crewed ship uses: ${reason}; ${NEXT_AFTER_FAILURE}`);
      return state;
    }
    if (action.kind === 'status' || action.kind === 'refuse') {
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
  // Every failed crew is a failed start of the machine's too (#853).
  const counted = countStarts(state, { outcomes: [{ kind: 'failed', shipId: entry.shipId, reason }], deps });
  state = counted.state;
  const crewFailures = (entry.crewFailures ?? 0) + 1;
  const logged = { ...about(state, { shipId: entry.shipId, action: 'crew' }), outcome: `failed: ${reason}` };
  if (crewFailures < CREW_FAILURE_BUDGET) {
    const next = putEntry(state, { ...entry, crewFailures });
    await deps.state.save(next);
    log(deps, { ...logged, next: NEXT_AFTER_FAILURE });
    await tellStopped(next, { isNewlyStopped: counted.isNewlyStopped, deps });
    return next;
  }
  log(deps, { ...logged, next: `failed ${String(CREW_FAILURE_BUDGET)} times in a row, so the trierarch gives it back` });
  await deps.state.save(state);
  await tellStopped(state, { isNewlyStopped: counted.isNewlyStopped, deps });
  const given = `crew failed ${String(CREW_FAILURE_BUDGET)} times: ${reason}`;
  return giveBack(state, { action: { kind: 'giveBack', shipId: entry.shipId, settingsVersion: entry.settingsVersion, reason: given, entry }, deps });
}

/**
 * What runs: the sessions, every folder under the root, and for each entry
 * whose session runs (or should, after a restart of the machine) its inbox and
 * turn. An inbox is watched only while its session runs, so last seen still
 * means the session is alive; a crewing one from the moment its session runs (#473).
 */
async function observe(state: TrierarchState, at: { deps: RunPassDeps; missingPlugins: ReadonlySet<string> }): Promise<Observed> {
  const { deps, missingPlugins } = at;
  const sessions = await deps.processes.list();
  const folders = await deps.workspace.foldersUnderRoot();
  const ships: Record<string, Observed['ships'][string]> = {};
  const launches: Record<string, LaunchSeen> = {};
  const withoutIdentity: ShipId[] = [];
  const startProblems: Record<string, string> = {};
  const shipFoldersGone: ShipId[] = [];
  for (const entry of Object.values(state.entries)) {
    if (entry.shipFolder !== undefined && keepsShipFolder(entry) && !(await deps.workspace.hasShipFolder(entry.shipFolder))) {
      shipFoldersGone.push(entry.shipId);
    }
    const session = sessions.find((each) => each.shipId === entry.shipId);
    // Asked only of an entry whose session would start: a running session keeps the login it started with (K3).
    if (entry.state === 'restarting' || (entry.state === 'running' && session === undefined)) {
      const problem = await deps.modelLogins.startProblem({ harness: entry.harness, login: sessionLogin(entry, deps), options: entry.options, ...(entry.folder !== undefined && { folder: entry.folder }) });
      if (problem !== undefined) {
        startProblems[entry.shipId] = problem;
      }
    }
    const { folder } = entry;
    const harness = missingPlugins.has(entry.harness) ? undefined : harnessOf(entry, deps);
    // A crewing session's launch window (#382), and a final crew's first minute after a restart (#397).
    const { launchId } = entry;
    if ((entry.state === 'crewing' || entry.state === 'running') && entry.launchedAt !== undefined && launchId !== undefined && folder !== undefined && session !== undefined && harness !== undefined) {
      const model = entry.options[MODEL_OPTION];
      launches[entry.shipId] = await harness.launchSeen({ ...sessionOf(entry, folder), launchId, ...(model !== undefined && { model }) });
    }
    const isWatched = (entry.state === 'running' || (entry.state === 'crewing' && session !== undefined)) && session?.status !== 'exited';
    // Its identity is looked at too while the trierarch would report on its behalf, as when its session exits in this pass (#664).
    if ((!isWatched && !HOLDS_IDENTITY.has(entry.state)) || folder === undefined || harness === undefined) {
      continue;
    }
    const { crewToken } = entry;
    // An entry with no crew token in the state is crewed again (decision 0026), so its identity says nothing.
    if (crewToken === undefined) {
      continue;
    }
    if (!(await harness.hasIdentity(sessionOf(entry, folder)))) {
      withoutIdentity.push(entry.shipId);
      continue;
    }
    // Opened again after the trierarch stopped: its session keeps running and calls over it (decision 0026).
    await deps.sockets.open(entry.shipId, entry.shipFolder);
    if (isWatched) {
      const turn = await harness.turnOf(sessionOf(entry, folder));
      // The store is asked only when a hand-over could follow.
      const isHolding = turn === 'idle' && (await harness.isHolding(sessionOf(entry, folder)));
      const isKeyNotReady = entry.login === 'apiKey' && (await deps.modelLogins.keyState(entry.harness)).state !== 'ready';
      ships[entry.shipId] = { inbox: await deps.fleet.inbox(crewToken), turn, isHolding, ...(isKeyNotReady && { isKeyNotReady }) };
    }
  }
  return { sessions, folders, ships, launches, withoutIdentity, startProblems, shipFoldersGone };
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
    case 'crashed':
      await crashed({ action, deps });
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
    case 'removeStray':
      return removeStray(state, { folder: action.folder, deps });
    case 'crew':
    case 'launch':
    case 'wake':
    case 'force':
    case 'report':
      return carryOutForEntry(state, { action, deps });
  }
}

async function carryOutForEntry(state: TrierarchState, at: CarryOut & { action: Extract<Action, { kind: 'crew' | 'launch' | 'wake' | 'force' | 'report' }> }): Promise<TrierarchState> {
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
        await harness?.sessionDied(sessionOf(entry, entry.folder));
        const launchId = deps.newLaunchId();
        const login = sessionLogin(entry, deps);
        await deps.workspace.writeRootFiles({ folder: entry.folder, workspace: entry.workspace });
        await harness?.launch({
          shipId: entry.shipId,
          // An entry saved before the ship's name was kept goes by its id.
          shipName: entry.shipName ?? entry.shipId,
          folder: entry.folder,
          ...(entry.shipFolder !== undefined && { shipFolder: entry.shipFolder }),
          workspace: entry.workspace,
          checkouts: await checkoutsOf(entry, deps),
          harness: entry.harness,
          options: entry.options,
          isFirstStart: false,
          launchId,
          login,
        });
        log(deps, { ...about(state, { shipId: entry.shipId, action: 'launch' }), outcome: `started again in ${entry.folder}` });
        // Its first minute is checked from now, while it runs (#397).
        const launchedAt = deps.clock.now().toISOString();
        const next = putEntry(state, { ...entry, launchedAt, launchId, ...startedOn(entry, { login, at: launchedAt }) });
        await deps.state.save(next);
        return next;
      }
      return state;
    case 'wake':
      if (entry.folder !== undefined && (await harnessOf(entry, deps)?.handOver(sessionOf(entry, entry.folder))) === 'handed') {
        log(deps, { ...about(state, { shipId: entry.shipId, action: 'wake' }), outcome: 'handed a message over' });
      }
      return state;
    case 'force':
      if (entry.folder !== undefined && (await harnessOf(entry, deps)?.forceOver({ ...sessionOf(entry, entry.folder), isTurnBusy: action.isTurnBusy })) === 'handed') {
        log(deps, { ...about(state, { shipId: entry.shipId, action: 'wake' }), outcome: action.isTurnBusy ? 'stopped its turn and handed a forced message over' : 'handed a forced message over' });
      }
      return state;
    case 'report': {
      const { crewToken } = entry;
      if (crewToken === undefined || entry.folder === undefined || !(await harnessOf(entry, deps)?.hasIdentity(sessionOf(entry, entry.folder)))) {
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

/** The login the entry's next session starts on (api keys K5): an entry saved before its ship's name was kept goes by its id. */
function sessionLogin(entry: Entry, deps: RunPassDeps): Login {
  return loginOf({ ...(deps.logins !== undefined && { logins: deps.logins }), harness: entry.harness, shipName: entry.shipName ?? entry.shipId });
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
  const { crewToken: heldToken } = entry;
  if (entry.isOldLayout === true && heldToken !== undefined) {
    return crewInTheShipFolderLayout(state, { entry, harness, crewToken: heldToken, deps });
  }
  if (entry.isShipFolderGone === true && heldToken !== undefined) {
    return crewInAFreshShipFolder(state, { entry, harness, crewToken: heldToken, deps });
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
  // A ship crewed fresh keeps every file of its own in its ship's folder, kept before anything is made in it; one crewed before the
  // ship folders keeps its workspace where it was.
  if (crewing.folder === undefined && crewing.shipFolder === undefined) {
    crewing = { ...crewing, shipFolder: await deps.workspace.shipFolderOf(crewing.shipId) };
    state = putEntry(state, crewing);
    await deps.state.save(state);
  }
  const { shipFolder } = crewing;
  const { folder } = await deps.workspace.prepare({
    shipId: crewing.shipId,
    shipName: ship.name,
    workspace: crewing.workspace,
    ...(shipFolder !== undefined && { shipFolder }),
    ...(crewing.madeMain !== undefined && { madeMain: crewing.madeMain }),
  });
  crewing = { ...crewing, ...madeOf(crewing.workspace) };
  // Kept at once, so an crewing still crewing knows the workspace and identity to remove if it ends (#382).
  state = putEntry(state, { ...crewing, shipName: ship.name, folder });
  await deps.state.save(state);
  // A login that cannot start it is this computer's state (api keys A5): given back at once, it may be crewed on another. Asked in its folder with its options, whose own settings count (K6).
  const login = sessionLogin({ ...crewing, shipName: ship.name }, deps);
  const loginProblem = await deps.modelLogins.startProblem({ harness: crewing.harness, login, options: crewing.options, folder });
  if (loginProblem !== undefined) {
    return giveBack(state, { action: { kind: 'giveBack', shipId: crewing.shipId, settingsVersion: crewing.settingsVersion, reason: loginProblem, entry: { ...crewing, shipName: ship.name, folder } }, deps });
  }
  const { secret } = await deps.fleet.getStartingPrompt(crewing.shipId);
  const { crewToken } = await deps.fleet.register({ shipId: crewing.shipId, secret, harness: crewing.harness });
  // The crew token stays in the state; the session calls over its ship's socket, opened before it starts (decision 0026).
  crewing = { ...crewing, crewToken };
  state = putEntry(state, { ...crewing, shipName: ship.name, folder });
  await deps.state.save(state);
  const socket = await deps.sockets.open(crewing.shipId, shipFolder);
  const checkouts = await checkoutsOf(crewing, deps);
  await harness.prepareIdentity({
    folder,
    ...(shipFolder !== undefined && { shipFolder }),
    identity: {
      fleetUrl: deps.fleet.url,
      shipId: crewing.shipId,
      shipName: ship.name,
      socket,
      ...(crewing.squadron !== undefined && { squadron: crewing.squadron }),
      ...(checkouts.length > 0 && { checkouts }),
    },
    crewToken,
  });
  const launchId = deps.newLaunchId();
  await deps.workspace.writeRootFiles({ folder, workspace: crewing.workspace });
  await harness.launch({
    shipId: crewing.shipId,
    shipName: ship.name,
    folder,
    ...(shipFolder !== undefined && { shipFolder }),
    workspace: crewing.workspace,
    checkouts,
    harness: crewing.harness,
    options: crewing.options,
    isFirstStart: !crewing.hasStarted,
    launchId,
    login,
    ...(!crewing.hasStarted && crewing.firstPrompt !== undefined && { firstPrompt: crewing.firstPrompt }),
  });
  // Crewing still: its launch window is open, and only activity in it makes the crew final (#382).
  const { crewFailures, ...started } = crewing;
  const launchedAt = deps.clock.now().toISOString();
  const next = putEntry(state, { ...(crewFailures === undefined ? crewing : started), shipName: ship.name, folder, hasStarted: true, launchedAt, launchId, ...startedOn(crewing, { login, at: launchedAt }) });
  await deps.state.save(next);
  log(deps, { shipId: crewing.shipId, shipName: ship.name, action: 'crew', outcome: `crewed, ${crewing.harness} started in ${folder}` });
  return next;
}

/**
 * A ship released elsewhere is crewed again in a fresh worktree (row 11,
 * #475), in a ship's folder of its own whatever its workspace was: before it
 * registers, its workspace goes as a release's does. Its
 * session stops first, as a release's does, so nothing reads the worktree
 * while a session works in it, whatever the pass's stop did. The entry is
 * saved without its mark only once that is done, so a failed stop or remove
 * tries again on the next pass. Answers the entry it is crewed with.
 */
async function freshAfterReleaseElsewhere(at: EntryAt): Promise<Entry> {
  const { entry, deps } = at;
  await deps.processes.stop(entry.shipId);
  const workspace = await removeWorkspace({ entry, deps });
  log(deps, { ...(entry.shipName !== undefined && { shipName: entry.shipName }), shipId: entry.shipId, action: 'release', outcome: `released elsewhere, ${workspace}` });
  // Crewed fresh, in a ship's folder of its own, whatever its workspace was.
  const { isReleasedElsewhere, folder, shipFolder, ...fresh } = entry;
  return isReleasedElsewhere === undefined && folder === undefined && shipFolder === undefined ? entry : fresh;
}

/**
 * A ship crewed before the ship folder layout (decision 0013) is crewed again
 * in a fresh ship folder under the lease it holds: its session stops, its
 * workspace goes as a release's does, what it held unsaved logged, and it is
 * crewed as a ship whose ship's folder is gone is, a first start telling
 * nobody. The entry is saved without its mark once its workspace is gone, so
 * an interruption crews it again in a fresh ship folder.
 */
async function crewInTheShipFolderLayout(state: TrierarchState, at: EntryAt & { harness: HarnessPort; crewToken: string }): Promise<TrierarchState> {
  const { entry, deps } = at;
  await deps.processes.stop(entry.shipId);
  const workspace = await removeWorkspace({ entry, deps });
  log(deps, { ...about(state, { shipId: entry.shipId, action: 'crew' }), outcome: `crewed before the ship folder layout, ${workspace}, so it is crewed again in a fresh ship folder` });
  const { isOldLayout, folder, shipFolder, ...rest } = entry;
  // Crewed in a fresh ship's folder, as one whose folder is gone, whatever its workspace was.
  const fresh: Entry = { ...(isOldLayout === undefined && folder === undefined && shipFolder === undefined ? entry : rest), isShipFolderGone: true };
  const next = putEntry(state, fresh);
  await deps.state.save(next);
  return crewInAFreshShipFolder(next, { ...at, entry: fresh });
}

/**
 * A ship whose ship's folder is gone, as when ships/ was removed by hand, is
 * crewed again in a fresh one under the lease it holds: core removes the crew
 * request on a release, so the ship is never released and registered again.
 * Its session stops and its identity and socket go; then its workspace is made
 * in a new ship's folder, its identity written with the crew token its state
 * keeps, and its session started as a first start, telling nobody. Its usage
 * since the last send went with the folder.
 */
async function crewInAFreshShipFolder(state: TrierarchState, at: EntryAt & { harness: HarnessPort; crewToken: string }): Promise<TrierarchState> {
  const { entry, harness, crewToken, deps } = at;
  await deps.processes.stop(entry.shipId);
  if (entry.folder === undefined) {
    await deps.sockets.close(entry.shipId, entry.shipFolder);
    await deps.checkouts.remove(entry.shipId);
  } else {
    await removeIdentity({ entry, deps, folder: entry.folder });
  }
  const shipName = entry.shipName ?? entry.shipId;
  log(deps, { ...about(state, { shipId: entry.shipId, action: 'crew' }), outcome: `its ship's folder ${entry.shipFolder ?? ''} is gone, so it is crewed again in a fresh one` });
  const shipFolder = await deps.workspace.shipFolderOf(entry.shipId);
  const { folder } = await deps.workspace.prepare({ shipId: entry.shipId, shipName, workspace: entry.workspace, shipFolder });
  // The mark stays until the ship is crewed again, so an interruption crews it again here, never releasing it.
  const crewing: Entry = { ...entry, folder, shipFolder, ...madeOf(entry.workspace) };
  state = putEntry(state, crewing);
  await deps.state.save(state);
  const socket = await deps.sockets.open(entry.shipId, shipFolder);
  const checkouts = await checkoutsOf(crewing, deps);
  await harness.prepareIdentity({
    folder,
    shipFolder,
    identity: { fleetUrl: deps.fleet.url, shipId: entry.shipId, shipName, socket, ...(entry.squadron !== undefined && { squadron: entry.squadron }), ...(checkouts.length > 0 && { checkouts }) },
    crewToken,
  });
  const login = sessionLogin(crewing, deps);
  const launchId = deps.newLaunchId();
  await deps.workspace.writeRootFiles({ folder, workspace: entry.workspace });
  await harness.launch({
    shipId: entry.shipId,
    shipName,
    folder,
    shipFolder,
    workspace: entry.workspace,
    checkouts,
    harness: entry.harness,
    options: entry.options,
    isFirstStart: true,
    launchId,
    login,
    ...(entry.firstPrompt !== undefined && { firstPrompt: entry.firstPrompt }),
  });
  const launchedAt = deps.clock.now().toISOString();
  const { isShipFolderGone, ...crewed } = crewing;
  const next = putEntry(state, { ...(isShipFolderGone === undefined ? crewing : crewed), hasStarted: true, launchedAt, launchId, ...startedOn(crewing, { login, at: launchedAt }) });
  await deps.state.save(next);
  log(deps, { shipId: entry.shipId, shipName, action: 'crew', outcome: `crewed again, ${entry.harness} started in ${folder}` });
  return next;
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
  const workspace = await removeWorkspace({ entry, deps });
  const next = removeEntry(state, shipId);
  await deps.state.save(next);
  await deps.fleet.confirmRelease(shipId);
  log(deps, { ...about(state, { shipId, action: 'release' }), outcome: `released, ${workspace}` });
  return next;
}

/**
 * The workspace of an entry whose crew ended here (gap rule 1): a release, a
 * release elsewhere, a give back, a retire or a ship moved to another
 * trierarch. What runs in its worktree stops, its last usage is sent (what it
 * used since the last send would be lost with the folder), its identity goes,
 * then the worktree is removed whatever it holds, so the next crew starts from
 * a fresh one. What it held is logged, and nobody is told: saving is the
 * session's job. A send the fleet refuses rejects, so the worktree stays and
 * the next pass tries again, as it does after a failed remove. A ship's
 * folder goes whole, its worktree or clone with it; a ship crewed before the
 * ship folders has its worktree removed as it was made. A configured folder
 * is never removed; the ship's folder of a ship in one goes. Answers what
 * became of it, as the log line says it.
 */
async function removeWorkspace(at: EntryAt): Promise<string> {
  const { entry, deps } = at;
  const { folder, shipFolder } = entry;
  if (folder === undefined) {
    if (shipFolder !== undefined) {
      await deps.workspace.removeShipFolder(shipFolder);
    }
    return 'its worktree removed';
  }
  if (entry.workspace.kind === 'repositories') {
    await deps.folderProcesses.stopIn(folder);
  }
  await deps.sendReleasedUsage(entry);
  await removeIdentity({ entry, deps, folder });
  if (entry.workspace.kind === 'folder') {
    if (shipFolder !== undefined) {
      await deps.workspace.removeShipFolder(shipFolder);
    }
    return `its folder kept: ${folder}`;
  }
  const held = await heldIn({ entry, deps, folder });
  await (shipFolder === undefined ? deps.workspace.remove(folder) : deps.workspace.removeShipFolder(shipFolder));
  const discarded = held.flatMap(({ unsaved }) => unsaved).length;
  if (discarded === 0) {
    return 'its worktree removed';
  }
  for (const repository of held.filter(({ unsaved }) => unsaved.length > 0)) {
    deps.logger.warn(`Discarded from the worktree of ${entry.shipName ?? entry.shipId} (${entry.shipId}), ${repository.folder}: ${repository.unsaved.join('; ')}`);
  }
  return `its worktree removed, discarding ${String(discarded)} unpushed ${discarded === 1 ? 'change' : 'changes'}`;
}

/** What removing the entry's workspace would discard, by each repository's folder: each repository of its ship folder, or the one worktree of a ship crewed before the ship folder layout. */
async function heldIn(at: EntryAt & { folder: string }): Promise<readonly { readonly folder: string; readonly unsaved: readonly string[] }[]> {
  const { entry, deps, folder } = at;
  return entry.isOldLayout === true ? [{ folder, unsaved: await deps.workspace.unsaved(folder) }] : deps.workspace.unsavedInShipFolder(folder);
}

/** A clear request (decision 0032): no worktree is kept, so it is confirmed not-kept, and the request goes. */
async function clear(state: TrierarchState, at: CarryOut & { action: Extract<Action, { kind: 'clear' }> }): Promise<TrierarchState> {
  const { action, deps } = at;
  const { shipId, repository } = action;
  await deps.fleet.confirmCleared({ shipId, repository, outcome: 'not-kept' });
  log(deps, { shipId, action: 'clear', outcome: `no kept ${repository} worktree of it here` });
  return state;
}

/**
 * A folder under the root no crewed ship uses (gap rule 2): an orphan
 * worktree, a session's own clone, a folder git does not know. What runs in it
 * stops first, as it would be left running from a folder that is gone; then it
 * is removed, whatever it holds, and what it held is logged. A failure is
 * logged and tried again on the next pass.
 */
async function removeStray(state: TrierarchState, at: { folder: string; deps: RunPassDeps }): Promise<TrierarchState> {
  const { folder, deps } = at;
  // A crew earlier in this pass may have set a folder that reconcile did not know yet.
  const used = Object.values(state.entries).flatMap((entry) => [entry.folder, entry.shipFolder].filter((each) => each !== undefined));
  if (used.some((each) => each === folder || each.startsWith(`${folder}/`) || folder.startsWith(`${each}/`))) {
    return state;
  }
  const stopped = await deps.folderProcesses.stopIn(folder);
  // What a folder git does not read held is not known; it goes all the same.
  const held = await deps.workspace.unsaved(folder).catch(() => []);
  await deps.workspace.remove(folder);
  const processes = stopped === 0 ? '' : `, after stopping ${String(stopped)} ${stopped === 1 ? 'process' : 'processes'} in it`;
  deps.logger.warn(`Removed ${folder}, a folder under the root no crewed ship uses${processes}${held.length === 0 ? '' : `, discarding: ${held.join('; ')}`}`);
  return state;
}

/**
 * Its request is no longer assigned here, as when its ship is retired or
 * moved to another trierarch (gap rule 1): the session stops and its
 * workspace goes as a release's does. The entry goes only then, so a failed
 * removal tries again on the next pass.
 */
async function forget(state: TrierarchState, at: EntryAt): Promise<TrierarchState> {
  const { entry, deps } = at;
  await deps.processes.stop(entry.shipId);
  const workspace = await removeWorkspace({ entry, deps });
  const next = removeEntry(state, entry.shipId);
  await deps.state.save(next);
  log(deps, { shipId: entry.shipId, ...(entry.shipName !== undefined && { shipName: entry.shipName }), action: 'forget', outcome: `its request is no longer assigned here, so its session stopped, ${workspace}` });
  return next;
}

/**
 * Gives back a request whose settings this trierarch cannot crew while its
 * crew is not final (#382): the session of an entry it crewed with stops
 * first, then the fleet takes the request back, with the reason after this
 * machine's name, cut to 200 characters, and ends the lease. When the fleet
 * refuses, the ship's owner is told instead, once per settings version. Either
 * way the entry's workspace then goes as a release's does, and the entry only
 * after it, so a failed removal tries again on the next pass, the request
 * then no longer assigned here.
 */
async function giveBack(state: TrierarchState, at: CarryOut & { action: Extract<Action, { kind: 'giveBack' }> }): Promise<TrierarchState> {
  const { action, deps } = at;
  const { shipId, settingsVersion, entry } = action;
  if (entry !== undefined) {
    await deps.processes.stop(shipId);
  }
  const machine = await deps.fleet.whoami();
  const reason = `${machine.name}: ${action.reason}`.slice(0, CREW_REQUEST_REASON_MAX_LENGTH);
  const answer = await deps.fleet.giveBack(shipId, { settingsVersion, reason });
  let next = state;
  if (answer.kind === 'refused') {
    deps.logger.warn(`The fleet refused to take back the crew request of ${shipId}: ${answer.code}: ${answer.message}`);
    next = await refuse(state, { action: { kind: 'refuse', shipId, settingsVersion, refusal: { reason: action.reason } }, deps });
  }
  const workspace = entry === undefined ? undefined : await removeWorkspace({ entry, deps });
  if (entry !== undefined) {
    next = removeEntry(next, shipId);
    await deps.state.save(next);
  }
  if (answer.kind === 'givenBack') {
    log(deps, { shipId, ...(entry?.shipName !== undefined && { shipName: entry.shipName }), action: 'giveBack', outcome: `given back: ${reason}${workspace === undefined ? '' : `, ${workspace}`}` });
  }
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
  await deps.fleet.reportToArgo({
    text: modelRefusedText({ shipId, shipName }, { harness, version, model }),
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
  await deps.fleet.reportToArgo({
    text: identityGoneText({ shipId, shipName }),
    idempotencyKey: `trierarch:identity-gone:${shipId}:${deps.clock.now().toISOString()}`,
  });
  log(deps, { shipId, ...(shipName !== undefined && { shipName }), action: 'identityGone', outcome: 'its folder holds no identity, so it is no longer woken; argo told' });
}

/** Tells the ship's owner, once per settings version, that this trierarch cannot crew them: the give-back notice. */
async function refuse(state: TrierarchState, at: CarryOut & { action: Extract<Action, { kind: 'refuse' }> }): Promise<TrierarchState> {
  const { action, deps } = at;
  const ship = await deps.fleet.ship(action.shipId);
  const name = ship.kind === 'awaitingCrew' || ship.kind === 'crewed' ? ship.name : undefined;
  const { field, reason } = action.refusal;
  const text = settingsRefusedText({ shipId: action.shipId, shipName: name }, { settingsVersion: action.settingsVersion, why: field === undefined ? reason : `${field}: ${reason}` });
  await reportTrouble(deps, { shipId: action.shipId, shipName: name, text: () => text, idempotencyKey: `trierarch:refused:${action.shipId}:${String(action.settingsVersion)}` });
  const next = { ...state, refused: { ...state.refused, [action.shipId]: action.settingsVersion } };
  await deps.state.save(next);
  deps.logger.warn(`Cannot crew ${name ?? action.shipId} (${action.shipId}), settings version ${String(action.settingsVersion)}: ${reason}`);
  return next;
}

/** A session's restart budget is spent (#397): its owner is told, in the words true for its reader. */
async function crashed(at: CarryOut & { action: Extract<Action, { kind: 'crashed' }> }): Promise<void> {
  const { action, deps } = at;
  const { shipId, shipName, exits, failedStart, idempotencyKey } = action;
  const told = await reportTrouble(deps, {
    shipId,
    shipName,
    text: (isForArgo) => crashText({ shipId, shipName }, { exits, isForArgo, ...(failedStart !== undefined && { failedStart }) }),
    idempotencyKey,
  });
  log(deps, { shipId, ...(shipName !== undefined && { shipName }), action: 'crashed', outcome: `crashed, its restart budget spent; ${told} told` });
}

/** argo's name: trouble of a ship argo owns, or of one with no owner, goes to argo by name. */
const OPERATOR_SHIP_NAME = 'argo';

/**
 * Tells a ship's owner of trouble with its crew (decision 0045): its owner
 * as the fleet holds it now, argo when argo owns it. When the fleet refuses
 * the report to a person's ship, as when no rule lets this trierarch reach
 * it, argo is told instead, with why, and it is logged. Answers the name of
 * the ship told.
 */
async function reportTrouble(deps: RunPassDeps, trouble: { shipId: ShipId; shipName: string | undefined; text: (isForArgo: boolean) => string; idempotencyKey: string }): Promise<string> {
  const { shipId, shipName, text, idempotencyKey } = trouble;
  const owner = (await deps.fleet.assignedRequests()).find((request) => request.shipId === shipId)?.owner ?? null;
  if (owner === null || owner.name === OPERATOR_SHIP_NAME) {
    await deps.fleet.reportToArgo({ text: text(true), idempotencyKey });
    return OPERATOR_SHIP_NAME;
  }
  const answer = await deps.fleet.reportToOwner({ ownerShipId: owner.shipId, text: text(false), idempotencyKey });
  if (answer.kind === 'sent') {
    return owner.name;
  }
  const { code, message } = answer;
  deps.logger.warn(`Could not reach ${owner.name} (${owner.shipId}), the owner of ${shipName ?? shipId} (${shipId}): ${code}: ${message}; argo is told instead`);
  await deps.fleet.reportToArgo({ text: ownerUnreachableText(text(true), { ownerName: owner.name, code, message }), idempotencyKey: `${idempotencyKey}:owner-unreachable` });
  return OPERATOR_SHIP_NAME;
}

/** The session's identity goes, and with it its ship's socket, as nothing calls over it any more (decision 0026), and its read-only checkouts (#1182). */
async function removeIdentity(at: EntryAt & { folder: string }): Promise<void> {
  const { entry, deps, folder } = at;
  await harnessOf(entry, deps)?.removeIdentity(sessionOf(entry, folder));
  await deps.sockets.close(entry.shipId, entry.shipFolder);
  await deps.checkouts.remove(entry.shipId);
}

/** The entry's session in its folder, with its ship's folder when it has one. */
/** What a ship folder was made of, kept with its entry so a new settings version naming another main repository replaces `main/`. */
function madeOf(workspace: Entry['workspace']): Pick<Entry, 'madeMain'> {
  return workspace.kind === 'repositories' ? { madeMain: workspace.main.repository } : {};
}

function sessionOf(entry: Entry, folder: string): HarnessSession {
  return { shipId: entry.shipId, folder, ...(entry.shipFolder !== undefined && { shipFolder: entry.shipFolder }) };
}

/** The read-only checkouts a session in the entry's repository gets (#1182), made when missing; none in a configured folder. */
async function checkoutsOf(entry: Entry, deps: RunPassDeps): Promise<readonly Checkout[]> {
  return entry.workspace.kind === 'repositories' ? deps.checkouts.prepare({ shipId: entry.shipId, repository: entry.workspace.main.repository }) : [];
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
