import type { ShipId, TrierarchWorkspace } from '@aeolus-fleet/common';

import type { LowResource } from './machine-load.js';

/**
 * The trierarch's saved state (docs/trierarch.md): an entry per ship it
 * crews, by ship id, the worktrees it kept, the orphans it found, and the
 * settings versions it told argo it cannot crew. Plain data, saved whole as
 * JSON in a file only the trierarch's user reads: it holds each crewed ship's
 * crew token, which never reaches the ship's folder or home (decision 0026).
 * The crew requests themselves live in the fleet.
 */
export interface TrierarchState {
  readonly entries: Readonly<Record<string, Entry>>;
  readonly kept: readonly KeptWorktree[];
  readonly orphans: readonly Orphan[];
  /** By ship id: the settings version argo was told this trierarch cannot crew, so it is told once. */
  readonly refused: Readonly<Record<string, number>>;
  /** What the machine is low on, as argo was told (#400), so it is told once per drop, a restart too; none while it is low on nothing. */
  readonly lowResources?: readonly LowResource[];
}

/** Where an entry stands: the crew statuses the trierarch writes, and releasing while it ends. */
export const ENTRY_STATES = ['crewing', 'running', 'restarting', 'crashed', 'releasing'] as const;

export type EntryState = (typeof ENTRY_STATES)[number];

/** One ship the trierarch crews, from the crew request assigned to it, with the settings of the version it crewed. */
export interface Entry {
  readonly shipId: ShipId;
  /** The ship's name, from the fleet when it is crewed: its session is named after it. */
  readonly shipName?: string;
  /** The settings version this entry crews with: a new one crews the ship again. */
  readonly settingsVersion: number;
  readonly harness: string;
  readonly workspace: TrierarchWorkspace;
  readonly squadron?: string;
  /** Given on the first start only. */
  readonly firstPrompt?: string;
  /** Option name to value name, as the settings picked them. */
  readonly options: Readonly<Record<string, string>>;
  readonly state: EntryState;
  /** When the entry took its state, ISO 8601. */
  readonly since: string;
  /** When its session exited within the restart window, oldest first, ISO 8601. */
  readonly exits: readonly string[];
  /** When a restarting entry starts again, ISO 8601. */
  readonly restartAt?: string;
  /** Where its workspace is, once made. */
  readonly folder?: string;
  /** The crew token its register gave, kept here only: its session calls the fleet over its ship's socket (decision 0026). */
  readonly crewToken?: string;
  readonly hasStarted: boolean;
  /** When the session crewing checks in its launch window started (#382), ISO 8601; none before its launch. */
  readonly launchedAt?: string;
  /** The launch id that session was started with (#490), set with launchedAt. */
  readonly launchId?: string;
  /** Set as it goes back to crewing after a release elsewhere (row 11): its worktree goes before it is crewed again (#475). */
  readonly isReleasedElsewhere?: true;
  /** How many crews of its settings version failed in a row (#827); none once one starts. */
  readonly crewFailures?: number;
  /** Set once argo is told its running session's folder holds no identity (#659), so it is told once; cleared when the identity is back. */
  readonly isIdentityGone?: true;
}

/** A worktree kept because it had changes, until a human clears it: reported by its ship and repository, never its path. */
export interface KeptWorktree {
  readonly shipId: ShipId;
  readonly repository: string;
  readonly path: string;
}

/** A worktree under the root with no assigned request: reported by its repository and name, never its path. */
export interface Orphan {
  readonly path: string;
  readonly repository: string;
  readonly name: string;
}

export const EMPTY_STATE: TrierarchState = { entries: {}, kept: [], orphans: [], refused: {} };

/** The entry in a new state since now. */
export function withState(entry: Entry, change: { state: EntryState; now: Date }): Entry {
  return { ...entry, state: change.state, since: change.now.toISOString() };
}

/** The state with one entry put in, or replaced. */
export function putEntry(state: TrierarchState, entry: Entry): TrierarchState {
  return { ...state, entries: { ...state.entries, [entry.shipId]: entry } };
}

/** The state without the ship's entry. */
export function removeEntry(state: TrierarchState, shipId: ShipId): TrierarchState {
  const entries = Object.fromEntries(Object.entries(state.entries).filter(([id]) => id !== shipId));
  return { ...state, entries };
}
