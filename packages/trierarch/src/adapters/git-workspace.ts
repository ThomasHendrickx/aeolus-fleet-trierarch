import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { ObservedWorktree, WorkspacePort } from '../core/ports.js';
import { gitInFolder, messageOf, RefusedRead } from './git-in-folder.js';
import { type CommandResult, runCommand } from './run-command.js';
import { clonedPath, cloneWhenMissing, type TrustedClones } from './trusted-clones.js';

/**
 * Workspaces (docs/architecture.md, "First adapters"): a git worktree of a
 * configured repository under the worktree root, one folder per ship
 * (`<root>/<repository>/<ship>`), detached at the settings' ref or the
 * repository's HEAD; or a configured folder used as it is. The repository is
 * fetched first, and a ref the remote has a branch for is that remote branch,
 * so a ship starts from current code, not from a stale local branch. A fetch
 * that fails (offline, no remote) leaves what the repository has.
 * A trusted repository the machine does not have yet is cloned first
 * (aeolus-fleet#384).
 */

const REMOTE = 'origin';

/** What a folder the host does not read holds, as unsaved: not known, so it is told with why, never taken for clean. */
export const REFUSED_PREFIX = 'refused, ';

export function createGitWorkspace(options: {
  configuration: TrierarchConfiguration;
  root: string;
  clones?: TrustedClones;
  /** Git in a ship's folder; a worktree's, unless the workspaces are clones. */
  inFolder?: (folder: string, args: readonly string[]) => Promise<CommandResult>;
}): WorkspacePort {
  const { configuration, root, clones, inFolder = gitInFolder } = options;
  const said = (args: readonly string[], result: CommandResult): string => {
    if (result.status !== 0) {
      // Git's message follows the subcommand at once: a reason is cut at a length, and the command's paths would use it up.
      const [subcommand, ...rest] = args[0] === '-C' ? args.slice(2) : args;
      const action = subcommand === 'worktree' ? `worktree ${rest[0] ?? ''}`.trim() : (subcommand ?? '');
      throw new Error(`git ${action} failed: ${messageOf(result.stderr)}`);
    }
    return result.stdout;
  };
  const git = async (args: readonly string[]): Promise<string> => said(args, await runCommand('git', { args }));
  /** Git in a ship's folder, which ignores the folder's own config where it names a program. */
  const gitIn = async (folder: string, args: readonly string[]): Promise<string> => said(args, await inFolder(folder, args));
  /** The remote branch for the ref when the remote has one, else the ref as it is. */
  const resolve = async (repository: string, ref: string): Promise<string> => {
    const remote = await runCommand('git', { args: ['-C', repository, 'rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${ref}`] });
    return remote.status === 0 ? `${REMOTE}/${ref}` : ref;
  };
  /** The branch origin has as its default: what its HEAD names, else the branch the clone's HEAD names (which may be unborn) when origin has it; none without one. */
  const defaultRef = async (repository: string): Promise<string | undefined> => {
    const head = await runCommand('git', { args: ['-C', repository, 'symbolic-ref', '--short', `refs/remotes/${REMOTE}/HEAD`] });
    if (head.status === 0 && head.stdout.trim() !== '') {
      return head.stdout.trim();
    }
    const branch = await runCommand('git', { args: ['-C', repository, 'symbolic-ref', '--short', 'HEAD'] });
    return branch.status === 0 && (await resolve(repository, branch.stdout.trim())).startsWith(`${REMOTE}/`) ? `${REMOTE}/${branch.stdout.trim()}` : undefined;
  };
  const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;
  const repositoryOf = async (folder: string): Promise<string | undefined> => {
    const [repository] = relative(root, folder).split(sep);
    if (repository === undefined) {
      return undefined;
    }
    // A clone whose repository left the trusted repositories still holds the worktrees made from it.
    return configuration.repositories[repository]?.path ?? (await clonedPath(clones, repository));
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
      await cloneWhenMissing(clones, { repository: workspace.repository, path: repository });
      const folder = join(root, workspace.repository, shipName);
      // A worktree a stop mid-crew left is used as it is.
      if (!(await exists(folder))) {
        await mkdir(join(root, workspace.repository), { recursive: true });
        await runCommand('git', { args: ['-C', repository, 'fetch', '--quiet', REMOTE] });
        const ref = workspace.ref === undefined ? await defaultRef(repository) : await resolve(repository, workspace.ref);
        await git(['-C', repository, 'worktree', 'add', '--detach', folder, ...(ref === undefined ? [] : [ref])]);
      }
      return { folder };
    },
    isClean: async (folder) => {
      try {
        return (await gitIn(folder, ['status', '--porcelain', '--ignore-submodules=all'])).trim() === '';
      } catch (error) {
        if (error instanceof RefusedRead) {
          return false;
        }
        throw error;
      }
    },
    unsaved: async (folder) => {
      try {
        const changes = await gitIn(folder, ['status', '--porcelain', '--ignore-submodules=all']);
        const commits = await gitIn(folder, ['log', '--no-show-signature', '--format=commit %h %s', 'HEAD', '--not', '--branches', '--tags', '--remotes']);
        return [...changes.split('\n'), ...commits.split('\n')].filter((line) => line !== '');
      } catch (error) {
        if (error instanceof RefusedRead) {
          return [`${REFUSED_PREFIX}${error.reason}`];
        }
        throw error;
      }
    },
    isMade: async (folder) => {
      const parts = relative(root, folder).split(sep);
      const repository = parts.length === 2 ? await repositoryOf(folder) : undefined;
      if (repository === undefined) {
        return false;
      }
      const listed = await runCommand('git', { args: ['-C', repository, 'worktree', 'list', '--porcelain'] });
      if (listed.status !== 0) {
        return false;
      }
      // Git writes real paths, so a root reached over a link is compared by its real path too.
      const known = new Set(listed.stdout.split('\n').flatMap((line) => (line.startsWith('worktree ') ? [line.slice('worktree '.length)] : [])));
      return known.has(folder) || known.has(await realpath(folder).catch(() => folder));
    },
    remove: async (folder) => {
      const repository = await repositoryOf(folder);
      if (repository === undefined) {
        throw new Error(`${folder} is no worktree under ${root}: the trierarch removes only what it made`);
      }
      await git(['-C', repository, 'worktree', 'remove', '--force', folder]);
    },
    prune: async (repository) => {
      const path = configuration.repositories[repository]?.path;
      if (path === undefined) {
        throw new Error(`The configuration has no repository ${repository}`);
      }
      await git(['-C', path, 'worktree', 'prune']);
    },
    worktrees: async () => {
      const found: ObservedWorktree[] = [];
      // git lists each worktree by its real path, so a root reached through a symbolic link (macOS's /var) is matched by its own.
      const realRoot = await realpath(root).catch(() => root);
      for (const repository of Object.keys(configuration.repositories)) {
        const source = await repositoryOf(join(root, repository, 'worktree'));
        if (source === undefined) {
          continue;
        }
        const listed = await runCommand('git', { args: ['-C', source, 'worktree', 'list', '--porcelain'] });
        if (listed.status !== 0) {
          continue;
        }
        for (const line of listed.stdout.split('\n')) {
          if (!line.startsWith('worktree ')) {
            continue;
          }
          const parts = relative(realRoot, line.slice('worktree '.length)).split(sep);
          const [listedRepository, name] = parts;
          if (listedRepository === repository && name !== undefined && parts.length === 2) {
            found.push({ path: join(root, repository, name), repository, name });
          }
        }
      }
      return found;
    },
  };
}
