import { wantCommandSchema, type ShipId, type TrierarchConfiguration, type WantCommand } from '@aeolus-fleet/common';

import type { Entry, TrierarchState } from './entry.js';
import { err, ok, type Result } from './shared/result.js';

/** Why a want was refused: the field, when one is at fault, and a reason a requester can read. */
export interface Refusal {
  readonly field?: string;
  readonly reason: string;
}

/** A want that parses and fits what the configuration offers, before the fleet is asked about its ship. */
export interface CheckedWant {
  readonly want: WantCommand;
  readonly options: Readonly<Record<string, string>>;
}

/**
 * Checks a want against the protocol schema, the configuration (harness,
 * repository or folder, each option and its value) and the wanted list (the
 * ships cap, one ship per folder), naming the
 * field at fault. Anything unknown is refused (decision 0027).
 */
export function checkWant(payload: unknown, context: { configuration: TrierarchConfiguration; state: TrierarchState }): Result<CheckedWant, Refusal> {
  const parsed = wantCommandSchema.safeParse(payload);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return err({ ...fieldOf(issue?.path), reason: issue?.message ?? 'The want does not parse' });
  }
  const want = parsed.data;
  const { configuration, state } = context;
  const harness = configuration.harnesses[want.harness];
  if (harness === undefined) {
    return err({ field: 'harness', reason: `This trierarch offers no harness ${want.harness}` });
  }
  const workspaceRefusal = refusalOfWorkspace(want, context);
  if (workspaceRefusal !== undefined) {
    return err(workspaceRefusal);
  }
  const options: Record<string, string> = {};
  for (const [name, value] of Object.entries(want.options)) {
    const option = harness.options[name];
    if (option === undefined) {
      return err({ field: `options.${name}`, reason: `${want.harness} has no option ${name}` });
    }
    if (typeof value !== 'string' || !(value in option.values)) {
      return err({ field: `options.${name}`, reason: `${name} must be one of ${Object.keys(option.values).join(', ')}` });
    }
    options[name] = value;
  }
  if (Object.keys(state.entries).length >= configuration.caps.ships) {
    return err({ reason: `This trierarch keeps at most ${String(configuration.caps.ships)} ships` });
  }
  return ok({ want, options });
}

function refusalOfWorkspace(want: WantCommand, context: { configuration: TrierarchConfiguration; state: TrierarchState }): Refusal | undefined {
  const { configuration, state } = context;
  const { workspace } = want;
  switch (workspace.kind) {
    case 'worktree':
      return workspace.repository in configuration.repositories
        ? undefined
        : { field: 'workspace.repository', reason: `This trierarch offers no repository ${workspace.repository}` };
    case 'folder': {
      if (!(workspace.name in configuration.folders)) {
        return { field: 'workspace.name', reason: `This trierarch offers no folder ${workspace.name}` };
      }
      const crewing = Object.values(state.entries).find((entry) => entry.workspace.kind === 'folder' && entry.workspace.name === workspace.name);
      return crewing === undefined ? undefined : { field: 'workspace.name', reason: `The folder ${workspace.name} crews ${crewing.shipId} already: one folder crews one ship` };
    }
  }
}

/** The field an issue names, as `options.model`, when it names one. */
export function fieldOf(path: readonly PropertyKey[] | undefined): { field?: string } {
  return path === undefined || path.length === 0 ? {} : { field: path.map(String).join('.') };
}

/** A new entry for a checked want, wanted since now, for the ship that sent it. */
export function newEntry(checked: CheckedWant, context: { requester: ShipId; now: Date }): Entry {
  const { want, options } = checked;
  return {
    shipId: want.shipId,
    harness: want.harness,
    workspace: want.workspace,
    ...(want.squadron !== undefined && { squadron: want.squadron }),
    ...(want.firstPrompt !== undefined && { firstPrompt: want.firstPrompt }),
    options,
    requester: context.requester,
    state: 'wanted',
    since: context.now.toISOString(),
    exits: [],
    hasStarted: false,
    wake: { waiting: 0, isPending: false },
  };
}
