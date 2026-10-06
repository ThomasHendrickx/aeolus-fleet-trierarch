import type { ShipId, TrierarchEntryState, TrierarchWorkspace } from '@aeolus-fleet/common';

/**
 * The trierarch's saved state (docs/trierarch.md): the wanted list by ship id,
 * the messages it applied with the answers it sent for them, the worktrees it
 * kept, and the orphans it found. Plain data, saved whole as JSON, never a
 * secret: a session's crew token lives only in its folder's identity file.
 */
export interface TrierarchState {
  readonly entries: Readonly<Record<string, Entry>>;
  /** Each applied message's answers, by message id, so a message applied before changes nothing. */
  readonly applied: Readonly<Record<string, readonly Outgoing[]>>;
  readonly kept: readonly KeptWorktree[];
  readonly orphans: readonly string[];
}

/** One ship the trierarch keeps crewed, with the settings its want gave. */
export interface Entry {
  readonly shipId: ShipId;
  readonly harness: string;
  readonly workspace: TrierarchWorkspace;
  readonly squadron?: string;
  /** Given on the first start only. */
  readonly firstPrompt?: string;
  /** Option name to value name, as the want picked them. */
  readonly options: Readonly<Record<string, string>>;
  /** The ship that sent the want: notices go to it. */
  readonly requester: ShipId;
  readonly state: TrierarchEntryState;
  /** When the entry took its state, ISO 8601. */
  readonly since: string;
  /** When its session exited within the restart window, oldest first, ISO 8601. */
  readonly exits: readonly string[];
  /** When a restarting entry starts again, ISO 8601. */
  readonly restartAt?: string;
  /** Where its workspace is, once made. */
  readonly folder?: string;
  readonly hasStarted: boolean;
  /** The release a message asked for, answered once the ship is released. */
  readonly release?: { readonly messageId: string; readonly sender: ShipId; readonly isForced: boolean };
  /** The inbox count last seen, and whether a wake waits for the session to turn idle. */
  readonly wake: { readonly waiting: number; readonly isPending: boolean };
}

/** A worktree kept because it had changes, until a human or a release with force clears it. */
export interface KeptWorktree {
  readonly shipId: ShipId;
  readonly path: string;
}

/** A message the trierarch sends: an answer in reply to a command, or a notice. */
export interface Outgoing {
  readonly to: ShipId;
  readonly inReplyTo?: string;
  /** The protocol name, such as `wanted`: its content type is `trierarchContentType(name)`. */
  readonly name: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The same each time this message is sent again, so the fleet stores it once. */
  readonly idempotencyKey: string;
}

export const EMPTY_STATE: TrierarchState = { entries: {}, applied: {}, kept: [], orphans: [] };

/** The entry in a new state since now. */
export function withState(entry: Entry, change: { state: TrierarchEntryState; now: Date }): Entry {
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
