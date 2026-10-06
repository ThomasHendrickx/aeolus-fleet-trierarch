import type { ShipId, TrierarchConfiguration } from '@aeolus-fleet/common';

import { putEntry, withState, type Entry, type Outgoing, type TrierarchState } from './entry.js';
import type { InboxAnswer, ObservedSession, ObservedWorktree, Turn } from './ports.js';
import { decideRestart, exitsInWindow } from './restart-policy.js';

/**
 * The Reconciler (docs/architecture.md, "The trierarch"): a pure function
 * from the wanted list, what runs and the time to the actions that make them
 * match, and the state those actions start from. It is the only place that
 * decides; the run pass only carries the actions out.
 */

/** What the trierarch saw this pass. */
export interface Observed {
  readonly sessions: readonly ObservedSession[];
  readonly worktrees: readonly ObservedWorktree[];
  /** For each entry whose session it watches: its inbox and its turn. */
  readonly ships: Readonly<Record<string, { readonly inbox: InboxAnswer; readonly turn: Turn }>>;
}

export type Action =
  /** Crew the ship: starting prompt, register, workspace, identity, launch. Resumed when a stop mid-crew left it crewing. */
  | { readonly kind: 'crew'; readonly shipId: ShipId; readonly isResumed: boolean }
  /** Start its session again in its folder, continuing. */
  | { readonly kind: 'launch'; readonly shipId: ShipId }
  | { readonly kind: 'stop'; readonly shipId: ShipId }
  | { readonly kind: 'wake'; readonly shipId: ShipId }
  /** Release asked by a message: stop, end the lease, the workspace, answer released. */
  | { readonly kind: 'release'; readonly shipId: ShipId }
  /** The lease ended elsewhere (released, re-crewed or retired): stop, the workspace, notify leaseEnded. */
  | { readonly kind: 'drop'; readonly shipId: ShipId }
  | { readonly kind: 'notify'; readonly message: Outgoing }
  /** Report on the ship's behalf, with its session's crew token. */
  | { readonly kind: 'report'; readonly shipId: ShipId; readonly note: string };

export interface Reconciled {
  readonly state: TrierarchState;
  readonly actions: readonly Action[];
}

/** What reconciling needs beside the state and what was seen. */
export interface ReconcileContext {
  readonly observed: Observed;
  readonly now: Date;
  readonly configuration: TrierarchConfiguration;
}

const RESTARTING_NOTE = 'blocked: session crashed, restarting';
const CRASHED_NOTE = 'blocked: session crashed, restart budget spent';

export function reconcile(state: TrierarchState, context: ReconcileContext): Reconciled {
  const { observed, configuration } = context;
  let next: TrierarchState = state;
  const actions: Action[] = [];
  let running = observed.sessions.filter((session) => session.status === 'running' && session.shipId in state.entries).length;
  const canStart = (): boolean => running < configuration.caps.running;

  for (const entry of Object.values(state.entries)) {
    const step = stepOf(entry, { ...context, canStart: canStart() });
    next = step.entry === undefined ? next : putEntry(next, step.entry);
    actions.push(...step.actions);
    running += step.starts;
  }

  for (const session of observed.sessions) {
    if (!(session.shipId in state.entries)) {
      actions.push({ kind: 'stop', shipId: session.shipId });
    }
  }

  const known = new Set([...Object.values(state.entries).flatMap((entry) => (entry.folder === undefined ? [] : [entry.folder])), ...state.kept.map((kept) => kept.path)]);
  const orphans = observed.worktrees
    .filter((worktree) => !known.has(worktree.path) && (worktree.shipId === undefined || !(worktree.shipId in state.entries)))
    .map((worktree) => worktree.path);
  return { state: { ...next, orphans }, actions };
}

interface Step {
  readonly entry?: Entry;
  readonly actions: readonly Action[];
  /** Sessions this step starts, counted against the running cap. */
  readonly starts: number;
}

function stepOf(entry: Entry, context: ReconcileContext & { canStart: boolean }): Step {
  const { observed, now, canStart } = context;
  const seen = observed.ships[entry.shipId];
  if (entry.state === 'releasing') {
    return { actions: [{ kind: 'release', shipId: entry.shipId }], starts: 0 };
  }
  if (seen?.inbox.kind === 'leaseEnded') {
    return { actions: [{ kind: 'drop', shipId: entry.shipId }], starts: 0 };
  }
  switch (entry.state) {
    case 'wanted':
      return canStart
        ? { entry: withState(entry, { state: 'crewing', now }), actions: [{ kind: 'crew', shipId: entry.shipId, isResumed: false }], starts: 1 }
        : { actions: [], starts: 0 };
    case 'crewing':
      return { actions: [{ kind: 'crew', shipId: entry.shipId, isResumed: true }], starts: 1 };
    case 'running':
      return runningStep(entry, context);
    case 'restarting':
      return entry.restartAt !== undefined && now >= new Date(entry.restartAt) && canStart
        ? { entry: withState(entry, { state: 'running', now }), actions: [{ kind: 'launch', shipId: entry.shipId }], starts: 1 }
        : { actions: [], starts: 0 };
    case 'crashed':
      return { actions: [], starts: 0 };
  }
}

function runningStep(entry: Entry, context: ReconcileContext & { canStart: boolean }): Step {
  const { observed, now, canStart } = context;
  const session = observed.sessions.find((each) => each.shipId === entry.shipId);
  if (session === undefined) {
    // No session at all, as after the machine restarts: start it again, with no restart counted.
    return canStart ? { actions: [{ kind: 'launch', shipId: entry.shipId }], starts: 1 } : { actions: [], starts: 0 };
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
            {
              kind: 'notify',
              message: { to: entry.requester, name: 'crashed', payload: { shipId: entry.shipId, exits: exits.length }, idempotencyKey: `trierarch:crashed:${entry.shipId}:${now.toISOString()}` },
            },
          ],
          starts: 0,
        };
    }
  }
  return wakeStep(entry, observed.ships[entry.shipId]);
}

/** One wake per rise in the waiting count, given once the session is idle, and nothing more until it has received. */
function wakeStep(entry: Entry, seen: Observed['ships'][string] | undefined): Step {
  if (seen?.inbox.kind !== 'waiting') {
    return { actions: [], starts: 0 };
  }
  const { count } = seen.inbox;
  const isPending = count === 0 ? false : entry.wake.isPending || count > entry.wake.waiting;
  if (isPending && seen.turn === 'idle') {
    return { entry: { ...entry, wake: { waiting: count, isPending: false } }, actions: [{ kind: 'wake', shipId: entry.shipId }], starts: 0 };
  }
  const wake = { waiting: count, isPending };
  return wake.waiting === entry.wake.waiting && wake.isPending === entry.wake.isPending ? { actions: [], starts: 0 } : { entry: { ...entry, wake }, actions: [], starts: 0 };
}
