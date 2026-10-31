import { mkdir, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { ObservedWorktree, RefreshedCheckout, WorkspacePort } from '../core/ports.js';
import { bringToMain, makeReadOnlyClone, removeReadOnly } from './read-only-clone.js';

/**
 * Read-only workspaces (aeolus-fleet#1449; docs/trierarch.md, "Read-only
 * checkouts"): a configured repository the machine marks `readOnly`, as a
 * company session's working folder, gets a read-only clone on main
 * (read-only-clone.ts) at its worktree's path (`<root>/<repository>/<ship>`)
 * in place of a worktree, so a session can neither change nor push its
 * company's rules. Its refresh comes with the checkouts' and, as theirs, a
 * fetch that fails answers a problem. Every other workspace is the wrapped
 * one's, as are cleanliness and what removing discards.
 */
export function createReadOnlyWorkspace(options: { configuration: TrierarchConfiguration; root: string; readOnly: readonly string[]; workspaces: WorkspacePort }): WorkspacePort & {
  /** Brings a read-only workspace to the latest main; none for a workspace that is not read-only. */
  refresh(at: { repository: string; folder: string }): Promise<RefreshedCheckout | undefined>;
} {
  const { configuration, root, readOnly, workspaces } = options;
  const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;
  /** The read-only repository a folder is the workspace of, when it is `<root>/<repository>/<ship>` of one. */
  const readOnlyRepositoryOf = (folder: string): string | undefined => {
    const [repository, ship, ...rest] = relative(root, folder).split(sep);
    return repository !== undefined && readOnly.includes(repository) && ship !== undefined && ship !== '' && ship !== '..' && rest.length === 0 ? repository : undefined;
  };
  const pathOf = (repository: string): string | undefined => configuration.repositories[repository]?.path;

  return {
    ...workspaces,
    prepare: async (request) => {
      const { shipName, workspace } = request;
      const repository = workspace.kind === 'worktree' && readOnly.includes(workspace.repository) ? pathOf(workspace.repository) : undefined;
      if (workspace.kind === 'folder' || repository === undefined) {
        return workspaces.prepare(request);
      }
      const folder = join(root, workspace.repository, shipName);
      // A workspace the ship has already stays as it is: only a refresh moves it on.
      if (!(await exists(folder))) {
        await mkdir(join(root, workspace.repository), { recursive: true });
        await makeReadOnlyClone({ repository, path: folder });
      }
      return { folder, isReadOnly: true };
    },
    isMade: async (folder) => (readOnlyRepositoryOf(folder) === undefined ? workspaces.isMade(folder) : exists(join(folder, '.git'))),
    remove: async (folder) => (readOnlyRepositoryOf(folder) === undefined ? workspaces.remove(folder) : removeReadOnly(folder)),
    worktrees: async () => {
      const found: ObservedWorktree[] = [...(await workspaces.worktrees())];
      for (const repository of readOnly) {
        for (const name of await readdir(join(root, repository)).catch(() => [])) {
          const path = join(root, repository, name);
          // A clone has a .git of its own; listed once when the wrapped workspace lists its clones too.
          if ((await exists(join(path, '.git'))) && !found.some((worktree) => worktree.path === path)) {
            found.push({ path, repository, name });
          }
        }
      }
      return found;
    },
    refresh: async ({ repository, folder }) => {
      const source = readOnly.includes(repository) ? pathOf(repository) : undefined;
      if (source === undefined) {
        return undefined;
      }
      try {
        return { repository, revision: await bringToMain({ repository: source, path: folder }, { isFetchRequired: true }) };
      } catch (error) {
        return { repository, problem: (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '' };
      }
    },
  };
}
