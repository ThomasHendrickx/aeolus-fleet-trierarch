import type { CrewStatus, ShipId, TrierarchConfiguration } from '@aeolus-fleet/common';

import { checkSettings, type CheckedSettings, type Refusal } from './check-settings.js';
import { putEntry, removeEntry, withState, type Entry, type KeptWorktree, type TrierarchState } from './entry.js';
import type { ArgoReport, AssignedRequest, ClearRequestToMe, InboxAnswer, ObservedSession, ObservedWorktree, Turn, WrittenStatus } from './ports.js';
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
  /** Tell argo it cannot crew this settings version. */
  | { readonly kind: 'refuse'; readonly shipId: ShipId; readonly settingsVersion: number; readonly refusal: Refusal }
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
}

const RESTARTING_NOTE = 'blocked: session crashed, restarting';
const CRASHED_NOTE = 'blocked: session crashed, restart budget spent';

/** The statuses the reconciler writes; crewing and running at the first crew are the crew's own to write. */
const WRITTEN: ReadonlySet<Entry['state']> = new Set(['running', 'restarting', 'crashed']);

interface Step {
  readonly entry?: Entry;
  readonly actions: readonly Action[];
  /** Sessions this step starts, counted against the running cap. */
  readonly starts: number;
}

const NOTHING: Step = { actions: [], starts: 0 };

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
    const step = request.settingsVersion === entry.settingsVersion ? stepOf(entry, { ...context, canStart: canStart() }) : newVersionStep(entry, { request, state: next, context });
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
    const checked = checkSettings(request.settings, { shipId: request.shipId, configuration, state: next });
    if (!checked.isOk) {
      if (next.refused[request.shipId] !== request.settingsVersion) {
        actions.push({ kind: 'refuse', shipId: request.shipId, settingsVersion: request.settingsVersion, refusal: checked.error });
      }
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
  const { settings, options } = checked;
  return {
    shipId: at.shipId,
    settingsVersion: at.settingsVersion,
    harness: settings.harness,
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
 * Settings this trierarch cannot crew are refused to argo, and the entry
 * stays as it was.
 */
function newVersionStep(entry: Entry, at: { request: AssignedRequest; state: TrierarchState; context: ReconcileContext }): Step {
  const { request, state, context } = at;
  const checked = checkSettings(request.settings, { shipId: entry.shipId, configuration: context.configuration, state });
  if (!checked.isOk) {
    const step = stepOf(entry, { ...context, canStart: false });
    return state.refused[entry.shipId] === request.settingsVersion
      ? step
      : { ...step, actions: [...step.actions, { kind: 'refuse', shipId: entry.shipId, settingsVersion: request.settingsVersion, refusal: checked.error }] };
  }
  const fresh = entryOf(checked.value, { shipId: entry.shipId, settingsVersion: request.settingsVersion, now: context.now });
  return {
    entry: { ...fresh, hasStarted: entry.hasStarted, ...(entry.shipName !== undefined && { shipName: entry.shipName }), ...(entry.folder !== undefined && { folder: entry.folder }) },
    actions: [
      { kind: 'stop', shipId: entry.shipId },
      { kind: 'crew', shipId: entry.shipId, isResumed: true },
    ],
    starts: 0,
  };
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
      return { actions: [{ kind: 'crew', shipId: entry.shipId, isResumed: true }], starts: 1 };
    case 'running':
      return runningStep(entry, context);
    case 'restarting':
      return entry.restartAt !== undefined && now >= new Date(entry.restartAt) && canStart
        ? { entry: withState(entry, { state: 'running', now }), actions: [{ kind: 'launch', shipId: entry.shipId }], starts: 1 }
        : NOTHING;
    case 'crashed':
    case 'releasing':
      return NOTHING;
  }
}

function runningStep(entry: Entry, context: ReconcileContext & { canStart: boolean }): Step {
  const { observed, now, canStart } = context;
  const session = observed.sessions.find((each) => each.shipId === entry.shipId);
  if (session === undefined) {
    // No session at all, as after the machine restarts: start it again, with no restart counted.
    return canStart ? { actions: [{ kind: 'launch', shipId: entry.shipId }], starts: 1 } : NOTHING;
  }
  if (session.status === 'exited') {
    const exits = [...exitsInWindow(entry.exits, now), now.toISOString()];
    const decision = decideRestart(exits, now);
    switch (decision.kind) {
      case 'restart':
        return {
          entry: { ...withState(entry, { state: 'restarting', now }), exits, restartAt: decision.at.toISOString() },
          actions: [{ kind: 'report', shipId: entry.shipId, note: RESTARTING_NOTE }],
          starts: 0,
        };
      case 'crashed':
        return {
          entry: { ...withState(entry, { state: 'crashed', now }), exits },
          actions: [
            { kind: 'stop', shipId: entry.shipId },
            { kind: 'report', shipId: entry.shipId, note: CRASHED_NOTE },
            { kind: 'argo', report: crashReport(entry, { exits: exits.length, now }) },
          ],
          starts: 0,
        };
    }
  }
  return wakeStep(entry, observed.ships[entry.shipId]);
}

/** What argo is told when a session's restart budget is spent: a human decides. */
function crashReport(entry: Entry, at: { exits: number; now: Date }): ArgoReport {
  return {
    text: `${entry.shipName ?? entry.shipId} (${entry.shipId}): its session crashed ${String(at.exits)} times within an hour, restart budget spent; status crashed. Restart it in the console to crew it again.`,
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
