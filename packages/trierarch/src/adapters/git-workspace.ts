import { mkdir, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { ObservedWorktree, WorkspacePort } from '../core/ports.js';
import { runCommand } from './run-command.js';

/**
 * Workspaces (docs/architecture.md, "First adapters"): a git worktree of a
 * configured repository under the worktree root, one folder per ship
 * (`<root>/<repository>/<ship>`), detached at the want's ref or the
 * repository's HEAD; or a configured folder used as it is.
 */
export function createGitWorkspace(options: { configuration: TrierarchConfiguration; root: string }): WorkspacePort {
  const { configuration, root } = options;
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await runCommand('git', { args });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
  const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;
  const repositoryOf = (folder: string): string | undefined => {
    const [repository] = relative(root, folder).split(sep);
    return repository === undefined ? undefined : configuration.repositories[repository]?.path;
  };

  return {
    prepare: async ({ shipName, workspace }) => {
      if (workspace.kind === 'folder') {
        const folder = configuration.folders[workspace.name]?.path;
        if (folder === undefined) {
          throw new Error(`The configuration has no folder ${workspace.name}`);
        }
        return { folder };
      }
      const repository = configuration.repositories[workspace.repository]?.path;
      if (repository === undefined) {
        throw new Error(`The configuration has no repository ${workspace.repository}`);
      }
      const folder = join(root, workspace.repository, shipName);
      // A worktree a stop mid-crew left is used as it is.
      if (!(await exists(folder))) {
        await mkdir(join(root, workspace.repository), { recursive: true });
        await git(['-C', repository, 'worktree', 'add', '--detach', folder, ...(workspace.ref === undefined ? [] : [workspace.ref])]);
      }
      return { folder };
    },
    isClean: async (folder) => (await git(['-C', folder, 'status', '--porcelain'])).trim() === '',
    remove: async (folder) => {
      const repository = repositoryOf(folder);
      if (repository === undefined) {
        throw new Error(`${folder} is no worktree under ${root}: the trierarch removes only what it made`);
      }
      await git(['-C', repository, 'worktree', 'remove', '--force', folder]);
    },
    worktrees: async () => {
      const found: ObservedWorktree[] = [];
      for (const repository of await readdir(root).catch(() => [])) {
        for (const ship of await readdir(join(root, repository)).catch(() => [])) {
          found.push({ path: join(root, repository, ship) });
        }
      }
      return found;
    },
  };
}
