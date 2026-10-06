import type { ShipId, TrierarchEntryState, TrierarchWorkspace } from '@aeolus-fleet/common';

import type { StatePort } from '../core/ports.js';

/** `aeolus-trierarch list`: the wanted entries, from the saved state. */

export interface ListedEntry {
  readonly shipId: ShipId;
  readonly state: TrierarchEntryState;
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

export function describeList(entries: readonly ListedEntry[]): string {
  if (entries.length === 0) {
    return 'No ship is on the list.';
  }
  const rows = [
    ['SHIP', 'STATE', 'HARNESS', 'WORKSPACE', 'SINCE', 'RESTARTS'],
    ...entries.map((entry) => [entry.shipId, entry.state, entry.harness, entry.workspace, entry.since, String(entry.restarts)]),
  ];
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join(COLUMN_GAP)).join('\n');
}
