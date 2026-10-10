import type { CrewStatus, ShipId, TrierarchConfiguration } from '@aeolus-fleet/common';

import { checkSettings, trustRefusal, type CheckedSettings, type Refusal } from './check-settings.js';
import { MODEL_OPTION } from './detected-options.js';
import { putEntry, removeEntry, withState, type Entry, type KeptWorktree, type TrierarchState } from './entry.js';
import type { ArgoReport, AssignedRequest, ClearRequestToMe, InboxAnswer, LaunchSeen, ObservedSession, ObservedWorktree, TrustedPlaces, Turn, WrittenStatus } from './ports.js';
import { decideRestart, exitsInWindow } from './restart-policy.js';

/**
 * The Reconciler (docs/architecture.md, "The trierarch"): a pure function
 * from the crew requests assigned to the trierarch, its saved state, what
 * runs and the time to the actions that make them match, and the state those
 * actions start from. It is the only place that decides; the run pass only
 * carries the actions out.
 */

/** What the trierarch saw this pass. */
export interface Observed {
  readonly sessions: readonly ObservedSession[];
  readonly worktrees: readonly ObservedWorktree[];
  /** For each entry whose session it watches: its inbox and its turn. */
  readonly ships: Readonly<Record<string, { readonly inbox: InboxAnswer; readonly turn: Turn }>>;
  /** For each entry crewing whose session started: what its screen shows in its launch window (#382). */
  readonly launches: Readonly<Record<string, LaunchSeen>>;
}

export type Action =
  /** Crew the ship: starting prompt, register, workspace, identity, launch. Resumed while its own lease may still hold the ship. */
  | { readonly kind: 'crew'; readonly shipId: ShipId; readonly isResumed: boolean }
  /** Start its session again in its folder, continuing. */
  | { readonly kind: 'launch'; readonly shipId: ShipId }
  | { readonly kind: 'stop'; readonly shipId: ShipId }
  | { readonly kind: 'wake'; readonly shipId: ShipId }
  /** Its request was removed: stop, end the lease, the workspace, then confirm. */
  | { readonly kind: 'release'; readonly shipId: ShipId }
  /** A removed request it does not crew: confirm alone. */
  | { readonly kind: 'confirm'; readonly shipId: ShipId }
  /** Its request is no longer assigned here: stop, remove the identity of the entry it was; the worktree stays as an orphan. */
  | { readonly kind: 'forget'; readonly shipId: ShipId; readonly entry: Entry }
  | { readonly kind: 'status'; readonly shipId: ShipId; readonly written: WrittenStatus }
  /** Report on the ship's behalf, with its session's crew token. */
  | { readonly kind: 'report'; readonly shipId: ShipId; readonly note: string }
  /** Tell argo it cannot crew this settings version: its crew is final, so it is not given back. */
  | { readonly kind: 'refuse'; readonly shipId: ShipId; readonly settingsVersion: number; readonly refusal: Refusal }
  /**
   * Give back a request it cannot crew while its crew is not final (#382), with
   * why, without the machine's name, which the run pass adds. With the entry it
   * crewed with, which ends first: session, identity and clean worktree.
   */
  | { readonly kind: 'giveBack'; readonly shipId: ShipId; readonly settingsVersion: number; readonly reason: string; readonly entry?: Entry }
  /** A session refused the model it launched with (#382): kept refused at its harness's version, and argo told once. */
  | { readonly kind: 'modelRefused'; readonly shipId: ShipId; readonly shipName?: string; readonly harness: string; readonly version: string; readonly model: string }
  | { readonly kind: 'argo'; readonly report: ArgoReport }
  /** A clear request (decision 0032): remove the kept worktree it names, or, when none is kept, confirm alone. */
  | { readonly kind: 'clear'; readonly shipId: ShipId; readonly repository: string; readonly kept?: KeptWorktree };

export interface Reconciled {
  readonly state: TrierarchState;
  readonly actions: readonly Action[];
}

/** What reconciling needs beside the state and what was seen. */
export interface ReconcileContext {
  readonly requests: readonly AssignedRequest[];
  /** The pending clear requests to the trierarch's ship. */
  readonly clears: readonly ClearRequestToMe[];
  readonly observed: Observed;
  readonly now: Date;
  readonly configuration: TrierarchConfiguration;
  /** What each harness trusts now: checked before every launch (#381). */
  readonly trusted: TrustedPlaces;
  /** Each harness's version as detection found it, for the reason a refused model is given back with (#382). */
  readonly versions: Readonly<Record<string, string>>;
}

/** How long after its start a crewing session has to show activity (#382): its first prompt made a tool call. */
export const LAUNCH_WINDOW_MS = 60_000;

const NO_ACTIVITY_REASON = 'no activity within a minute of its start';

const RESTARTING_NOTE = 'blocked: session crashed, restarting';
const CRASHED_NOTE = 'blocked: session crashed, restart budget spent';

/** The statuses the reconciler writes; crewing and running at the first crew are the crew's own to write. */
const WRITTEN: ReadonlySet<Entry['state']> = new Set(['running', 'restarting', 'crashed']);

interface Step {
  readonly entry?: Entry;
  /** Set when the step gives the request back: its entry ends. */
  readonly isGivenBack?: boolean;
  readonly actions: readonly Action[];
  /** Sessions this step starts, counted against the running cap. */
  readonly starts: number;
}

const NOTHING: Step = { actions: [], starts: 0 };

/** The statuses at which a crew is final (decision 0029): it is no longer given back. */
const FINAL: ReadonlySet<CrewStatus> = new Set(['running', 'restarting', 'crashed']);

/**
 * What the trierarch does with settings it cannot crew (#382): while the
 * crew is not final as the fleet holds it, it gives the request back with
 * the field at fault as the reason, ending the entry it crewed with; once it
 * is final, it tells argo, once per settings version.
 */
function uncrewable(at: { request: AssignedRequest; refusal: Refusal; state: TrierarchState; entry?: Entry }): Action[] {
  const { request, refusal, state, entry } = at;
  const { shipId, settingsVersion } = request;
  if (state.refused[shipId] === settingsVersion) {
    return [];
  }
  if (request.status === null || !FINAL.has(request.status)) {
    const reason = refusal.field === undefined ? refusal.reason : `${refusal.field}: ${refusal.reason}`;
    return [{ kind: 'giveBack', shipId, settingsVersion, reason, ...(entry !== undefined && { entry }) }];
  }
  return [{ kind: 'refuse', shipId, settingsVersion, refusal }];
}

export function reconcile(state: TrierarchState, context: ReconcileContext): Reconciled {
  const { observed, configuration, requests, now } = context;
  const requested = new Map(requests.map((request) => [request.shipId, request]));
  const assigned = new Set<string>(requested.keys());
  let next: TrierarchState = { ...state, refused: Object.fromEntries(Object.entries(state.refused).filter(([shipId]) => assigned.has(shipId))) };
  const actions: Action[] = [];
  let running = observed.sessions.filter((session) => session.status === 'running' && session.shipId in state.entries).length;
  const canStart = (): boolean => running < configuration.caps.running;

  for (const entry of Object.values(state.entries)) {
    const request = requested.get(entry.shipId);
    if (request === undefined) {
      next = removeEntry(next, entry.shipId);
      actions.push({ kind: 'forget', shipId: entry.shipId, entry });
      continue;
    }
    if (request.status === 'releasing') {
      actions.push({ kind: 'release', shipId: entry.shipId });
      continue;
    }
    const step =
      request.settingsVersion === entry.settingsVersion
        ? trustedStep(entry, { step: stepOf(entry, { ...context, canStart: canStart() }), request, state: next, context })
        : newVersionStep(entry, { request, state: next, context });
    if (step.isGivenBack === true) {
      next = removeEntry(next, entry.shipId);
      actions.push(...step.actions);
      continue;
    }
    const after = step.entry ?? entry;
    next = step.entry === undefined ? next : putEntry(next, step.entry);
    actions.push(...step.actions);
    if (WRITTEN.has(after.state) && request.status !== after.state && after.state !== 'releasing') {
      actions.push({ kind: 'status', shipId: entry.shipId, written: writtenStatusOf(after) });
    }
    running += step.starts;
  }

  for (const request of requests) {
    if (request.shipId in state.entries) {
      continue;
    }
    if (request.status === 'releasing') {
      actions.push({ kind: 'confirm', shipId: request.shipId });
      continue;
    }
    const checked = checkSettings(request.settings, { shipId: request.shipId, configuration, state: next, trusted: context.trusted });
    if (!checked.isOk) {
      actions.push(...uncrewable({ request, refusal: checked.error, state: next }));
      continue;
    }
    if (canStart()) {
      next = putEntry(next, entryOf(checked.value, { shipId: request.shipId, settingsVersion: request.settingsVersion, now }));
      actions.push({ kind: 'crew', shipId: request.shipId, isResumed: false });
      running += 1;
    }
  }

  for (const session of observed.sessions) {
    if (!(session.shipId in state.entries)) {
      actions.push({ kind: 'stop', shipId: session.shipId });
    }
  }

  // A kept worktree stays until it is gone from disk, as when a human removed it (#325). One an entry
  // works in again is that entry's worktree, no longer kept, so a clear never removes it (decision 0032).
  const onDisk = new Set(observed.worktrees.map((worktree) => worktree.path));
  const inUse = new Set(Object.values(next.entries).flatMap((entry) => (entry.folder === undefined ? [] : [entry.folder])));
  const kept = next.kept.filter((each) => onDisk.has(each.path) && !inUse.has(each.path));
  const known = new Set([...inUse, ...kept.map((each) => each.path)]);
  const orphans = observed.worktrees
    .filter((worktree) => !known.has(worktree.path) && (worktree.shipId === undefined || !(worktree.shipId in next.entries)))
    .map(({ path, repository, name }) => ({ path, repository, name }));
  // A clear request removes only a worktree this trierarch kept; for any other it keeps none (decision 0032).
  for (const { shipId, repository } of context.clears) {
    const held = kept.find((each) => each.shipId === shipId && each.repository === repository);
    actions.push({ kind: 'clear', shipId, repository, ...(held !== undefined && { kept: held }) });
  }
  return { state: { ...next, kept, orphans }, actions };
}

/**
 * The status an entry writes (#332): its state; the restart attempt, the
 * restarts made or under way within the window (a crashed entry's last exit
 * started none); and when the session it runs now started, the time it took
 * running, or null while none runs.
 */
export function writtenStatusOf(entry: Entry & { state: CrewStatus }): WrittenStatus {
  const attempt = entry.state === 'crashed' ? Math.max(0, entry.exits.length - 1) : entry.exits.length;
  return { status: entry.state, attempt, startedAt: entry.state === 'running' ? new Date(entry.since) : null };
}

/** A new entry, crewing since now, for checked settings of a version. */
function entryOf(checked: CheckedSettings, at: { shipId: ShipId; settingsVersion: number; now: Date }): Entry {
  const { settings, harness, options } = checked;
  return {
    shipId: at.shipId,
    settingsVersion: at.settingsVersion,
    harness,
    workspace: settings.workspace,
    ...(settings.squadron !== undefined && { squadron: settings.squadron }),
    ...(settings.firstPrompt !== undefined && { firstPrompt: settings.firstPrompt }),
    options,
    state: 'crewing',
    since: at.now.toISOString(),
    exits: [],
    hasStarted: false,
    wake: { waiting: 0, isPending: false },
  };
}

/**
 * A new settings version of a request it crews (Restart or Edit): the
 * session stops and the ship is crewed again with that version, in its
 * folder, with a fresh restart budget. It is no release: the worktree stays.
 * It is a first start (#443): a fresh session with the new version's first
 * prompt, never the old conversation continued.
 * Settings this trierarch cannot crew are given back while the crew is not
 * final, its entry ending; once it is final, argo is told and the entry stays
 * as it was.
 */
function newVersionStep(entry: Entry, at: { request: AssignedRequest; state: TrierarchState; context: ReconcileContext }): Step {
  const { request, state, context } = at;
  const checked = checkSettings(request.settings, { shipId: entry.shipId, configuration: context.configuration, state, trusted: context.trusted });
  if (!checked.isOk) {
    const uncrewed = uncrewable({ request, refusal: checked.error, state, entry });
    if (uncrewed.some((action) => action.kind === 'giveBack')) {
      return { isGivenBack: true, actions: uncrewed, starts: 0 };
    }
    const step = stepOf(entry, { ...context, canStart: false });
    return { ...step, actions: [...step.actions, ...uncrewed] };
  }
  const fresh = entryOf(checked.value, { shipId: entry.shipId, settingsVersion: request.settingsVersion, now: context.now });
  return {
    entry: { ...fresh, ...(entry.shipName !== undefined && { shipName: entry.shipName }), ...(entry.folder !== undefined && { folder: entry.folder }) },
    actions: [
      { kind: 'stop', shipId: entry.shipId },
      { kind: 'crew', shipId: entry.shipId, isResumed: true },
    ],
    starts: 0,
  };
}

/**
 * A step that would start the entry's session, held while its harness does
 * not trust its repository or folder (#381): trust is checked before every
 * launch, a restart too. While the crew is not final the request is given
 * back and the entry ends (#382); once it is final, the entry stays as it is
 * and argo is told once per settings version.
 */
function trustedStep(entry: Entry, at: { step: Step; request: AssignedRequest; state: TrierarchState; context: ReconcileContext }): Step {
  const { step, request, state, context } = at;
  const isLaunching = step.actions.some((action) => action.kind === 'crew' || action.kind === 'launch');
  const refusal = isLaunching ? trustRefusal({ harness: entry.harness, workspace: entry.workspace, trusted: context.trusted }) : undefined;
  if (refusal === undefined) {
    return step;
  }
  const held = step.actions.filter((action) => action.kind !== 'crew' && action.kind !== 'launch');
  const uncrewed = uncrewable({ request, refusal, state, entry });
  return { ...(uncrewed.some((action) => action.kind === 'giveBack') && { isGivenBack: true }), actions: [...held, ...uncrewed], starts: 0 };
}

function stepOf(entry: Entry, context: ReconcileContext & { canStart: boolean }): Step {
  const { observed, now, canStart } = context;
  const seen = observed.ships[entry.shipId];
  if (seen?.inbox.kind === 'leaseEnded') {
    // Released elsewhere (row 11): its session stops and the ship is crewed again, in its folder.
    return { entry: withState(entry, { state: 'crewing', now }), actions: [{ kind: 'stop', shipId: entry.shipId }, { kind: 'crew', shipId: entry.shipId, isResumed: false }], starts: 0 };
  }
  switch (entry.state) {
    case 'crewing':
      return launchStep(entry, context);
    case 'running':
      return runningStep(entry, context);
    case 'restarting':
      return entry.restartAt !== undefined && now >= new Date(entry.restartAt) && canStart
        ? { entry: withState(withoutLaunch(entry), { state: 'running', now }), actions: [{ kind: 'launch', shipId: entry.shipId }], starts: 1 }
        : NOTHING;
    case 'crashed':
    case 'releasing':
      return NOTHING;
  }
}

/**
 * An entry crewing: crewed (again) until its session started, then in its
 * launch window (#382). Activity makes the crew final, so it runs from when
 * its session started. A model refused, or no activity within the minute,
 * gives the request back, its entry ending. A session gone, as after the
 * machine restarts, is crewed again.
 */
function launchStep(entry: Entry, context: ReconcileContext): Step {
  const { observed, now } = context;
  const { launchedAt, ...running } = entry;
  const seen = observed.launches[entry.shipId];
  if (launchedAt === undefined || seen === undefined) {
    return { actions: [{ kind: 'crew', shipId: entry.shipId, isResumed: true }], starts: 1 };
  }
  const giveBack = (reason: string, first: readonly Action[] = []): Step => ({
    isGivenBack: true,
    actions: [...first, { kind: 'giveBack', shipId: entry.shipId, settingsVersion: entry.settingsVersion, reason, entry }],
    starts: 0,
  });
  switch (seen.kind) {
    case 'active':
      // Running since its session started, so the session start it writes is that start; the window is closed.
      return { entry: { ...running, state: 'running', since: launchedAt }, actions: [], starts: 0 };
    case 'refused': {
      const refused = modelRefusal(entry, { model: seen.model, versions: context.versions });
      return giveBack(refused.reason, refused.actions);
    }
    case 'none':
      return isWindowOver(launchedAt, now) ? giveBack(NO_ACTIVITY_REASON) : NOTHING;
  }
}

/** The entry with no launch window open. */
function withoutLaunch(entry: Entry): Entry {
  const { launchedAt, ...rest } = entry;
  return launchedAt === undefined ? entry : rest;
}

function isWindowOver(launchedAt: string, now: Date): boolean {
  return now.getTime() - new Date(launchedAt).getTime() >= LAUNCH_WINDOW_MS;
}

/**
 * Why a session refused the model it launched with, naming the harness and
 * its version, and the model kept refused when the settings picked it (#382).
 * The harness's own default refused drops nothing: the machine never offered
 * it as a model.
 */
function modelRefusal(entry: Entry, at: { model: string; versions: ReconcileContext['versions'] }): { reason: string; actions: Action[] } {
  const { harness } = entry;
  const version = at.versions[harness];
  const reason = `${harness}${version === undefined ? '' : ` ${version}`} refused ${at.model}`;
  if (entry.options[MODEL_OPTION] === undefined || version === undefined) {
    return { reason, actions: [] };
  }
  return { reason, actions: [{ kind: 'modelRefused', shipId: entry.shipId, ...(entry.shipName !== undefined && { shipName: entry.shipName }), harness, version, model: at.model }] };
}

function runningStep(entry: Entry, context: ReconcileContext & { canStart: boolean }): Step {
  const { observed, now, canStart } = context;
  const session = observed.sessions.find((each) => each.shipId === entry.shipId);
  if (session === undefined) {
    // No session at all, as after the machine restarts: start it again, with no restart counted.
    return canStart ? { entry: withoutLaunch(entry), actions: [{ kind: 'launch', shipId: entry.shipId }], starts: 1 } : NOTHING;
  }
  if (session.status === 'exited') {
    return exitStep(entry, { now });
  }
  return restartWindowStep(entry, context);
}

/**
 * A running entry whose session started again (#397): its crew is final, so
 * the check only observes. The session runs, is watched and woken as any
 * other; activity closes the window. A model refused, or no activity within
 * the minute, is a failed start: the session stops, and it counts against
 * the restart budget as an exit does, nothing given back.
 */
function restartWindowStep(entry: Entry, context: ReconcileContext): Step {
  const { observed, now } = context;
  const seen = observed.ships[entry.shipId];
  const { launchedAt } = entry;
  const launch = observed.launches[entry.shipId];
  if (launchedAt === undefined || launch === undefined) {
    return wakeStep(entry, seen);
  }
  switch (launch.kind) {
    case 'active': {
      const closed = withoutLaunch(entry);
      const step = wakeStep(closed, seen);
      return { ...step, entry: step.entry ?? closed };
    }
    case 'refused': {
      const refused = modelRefusal(entry, { model: launch.model, versions: context.versions });
      const step = exitStep(entry, { now, failedStart: refused.reason });
      return { ...step, actions: [...refused.actions, ...step.actions] };
    }
    case 'none':
      return isWindowOver(launchedAt, now) ? exitStep(entry, { now, failedStart: NO_ACTIVITY_REASON }) : wakeStep(entry, seen);
  }
}

/**
 * The session exited, or failed its start with the reason given (#397): it
 * starts again after its wait, or, with the restart budget spent, the entry
 * is crashed and argo told. A session that failed its start still runs, so it
 * stops first.
 */
function exitStep(entry: Entry, at: { now: Date; failedStart?: string }): Step {
  const { now, failedStart } = at;
  const exits = [...exitsInWindow(entry.exits, now), now.toISOString()];
  const decision = decideRestart(exits, now);
  const stop: Action = { kind: 'stop', shipId: entry.shipId };
  switch (decision.kind) {
    case 'restart':
      return {
        entry: { ...withState(withoutLaunch(entry), { state: 'restarting', now }), exits, restartAt: decision.at.toISOString() },
        actions: [...(failedStart === undefined ? [] : [stop]), { kind: 'report', shipId: entry.shipId, note: RESTARTING_NOTE }],
        starts: 0,
      };
    case 'crashed':
      return {
        entry: { ...withState(withoutLaunch(entry), { state: 'crashed', now }), exits },
        actions: [
          stop,
          { kind: 'report', shipId: entry.shipId, note: CRASHED_NOTE },
          { kind: 'argo', report: crashReport(entry, { exits: exits.length, now, ...(failedStart !== undefined && { failedStart }) }) },
        ],
        starts: 0,
      };
  }
}

/** What argo is told when a session's restart budget is spent, with why its last start failed when it did (#397): a human decides. */
function crashReport(entry: Entry, at: { exits: number; now: Date; failedStart?: string }): ArgoReport {
  const lastStart = at.failedStart === undefined ? '' : `; its last start: ${at.failedStart}`;
  return {
    text: `${entry.shipName ?? entry.shipId} (${entry.shipId}): its session crashed ${String(at.exits)} times within an hour, restart budget spent${lastStart}; status crashed. Restart it in the console to crew it again.`,
    idempotencyKey: `trierarch:crashed:${entry.shipId}:${at.now.toISOString()}`,
  };
}

/** One wake per rise in the waiting count, given once the session is idle, and nothing more until it has received. */
function wakeStep(entry: Entry, seen: Observed['ships'][string] | undefined): Step {
  if (seen?.inbox.kind !== 'waiting') {
    return NOTHING;
  }
  const { count } = seen.inbox;
  const isPending = count === 0 ? false : entry.wake.isPending || count > entry.wake.waiting;
  if (isPending && seen.turn === 'idle') {
    return { entry: { ...entry, wake: { waiting: count, isPending: false } }, actions: [{ kind: 'wake', shipId: entry.shipId }], starts: 0 };
  }
  const wake = { waiting: count, isPending };
  return wake.waiting === entry.wake.waiting && wake.isPending === entry.wake.isPending ? NOTHING : { entry: { ...entry, wake }, actions: [], starts: 0 };
}
