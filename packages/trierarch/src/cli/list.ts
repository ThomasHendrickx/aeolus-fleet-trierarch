import type { ShipId, TrierarchWorkspace } from '@aeolus-fleet/common';

import type { EntryState } from '../core/entry.js';
import type { StatePort } from '../core/ports.js';
import { PLAIN, stateTone, type Style } from '../adapters/style.js';

/** `aeolus-trierarch list`: the ships it crews, from the saved state. */

export interface ListedEntry {
  readonly shipId: ShipId;
  readonly state: EntryState;
  readonly harness: string;
  readonly workspace: string;
  readonly folder?: string;
  /** When the entry took its state, ISO 8601. */
  readonly since: string;
  /** How often its session exited within the restart window. */
  readonly restarts: number;
}

function describeWorkspace(workspace: TrierarchWorkspace): string {
  switch (workspace.kind) {
    case 'worktree':
      return `worktree ${workspace.repository}${workspace.ref === undefined ? '' : ` at ${workspace.ref}`}`;
    case 'folder':
      return `folder ${workspace.name}`;
  }
}

export async function inspectList(state: StatePort): Promise<ListedEntry[]> {
  return Object.values((await state.load()).entries).map((entry) => ({
    shipId: entry.shipId,
    state: entry.state,
    harness: entry.harness,
    workspace: describeWorkspace(entry.workspace),
    ...(entry.folder !== undefined && { folder: entry.folder }),
    since: entry.since,
    restarts: entry.exits.length,
  }));
}

const COLUMN_GAP = '  ';

const HEADER = ['SHIP', 'STATE', 'HARNESS', 'WORKSPACE', 'SINCE', 'RESTARTS'];
const STATE_COLUMN = 1;

/** A table, its columns aligned on the plain text: the header strong and each state in its tone where the style colours. */
export function describeList(entries: readonly ListedEntry[], style: Style = PLAIN): string {
  if (entries.length === 0) {
    return 'No ship is crewed here.';
  }
  const rows = [HEADER, ...entries.map((entry) => [entry.shipId, entry.state, entry.harness, entry.workspace, entry.since, String(entry.restarts)])];
  const widths = HEADER.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)));
  const toned = (cell: string, at: { row: number; column: number }): string => {
    if (at.row === 0) {
      return style.tone('strong', cell);
    }
    const entry = entries[at.row - 1];
    return at.column === STATE_COLUMN && entry !== undefined ? style.tone(stateTone(entry.state), cell) : cell;
  };
  return rows
    .map((row, rowAt) => row.map((cell, column) => toned(column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0), { row: rowAt, column })).join(COLUMN_GAP))
    .join('\n');
}
