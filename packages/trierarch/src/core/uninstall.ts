import type { ProcessPort, StatePort } from './ports.js';

/**
 * Use case: the trierarch is uninstalled (docs/trierarch.md, lifecycle row
 * 10). It stops every session first and lists the worktrees it leaves behind,
 * kept or still in use, and deletes nothing.
 */
export type Uninstall = () => Promise<{ worktrees: readonly string[] }>;

export function createUninstall(deps: { processes: ProcessPort; state: StatePort }): Uninstall {
  return async () => {
    const state = await deps.state.load();
    for (const session of await deps.processes.list()) {
      await deps.processes.stop(session.shipId);
    }
    const inUse = Object.values(state.entries).flatMap((entry) => (entry.folder === undefined || entry.workspace.kind === 'folder' ? [] : [entry.folder]));
    return { worktrees: [...state.kept.map((kept) => kept.path), ...inUse] };
  };
}
