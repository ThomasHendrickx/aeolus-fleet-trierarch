import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { ObservedWorktree, WorkspacePort } from '../core/ports.js';
import { runCommand } from './run-command.js';

/**
 * Workspaces (docs/architecture.md, "First adapters"): a git worktree of a
 * configured repository under the worktree root, one folder per ship
 * (`<root>/<repository>/<ship>`), detached at the settings' ref or the
 * repository's HEAD; or a configured folder used as it is. The repository is
 * fetched first, and a ref the remote has a branch for is that remote branch,
 * so a ship starts from current code, not from a stale local branch. A fetch
 * that fails (offline, no remote) leaves what the repository has.
 *
 * A trusted repository the machine does not have yet (aeolus-fleet#384) is
 * cloned first, once, with the machine's own access: over https or ssh only,
 * never asking for a password, into a partial folder renamed into place
 * whole, so a stop mid-clone leaves no half clone to crew from.
 */

const REMOTE = 'origin';

/** The protocols a clone of a trusted repository may use, as git's GIT_ALLOW_PROTOCOL lists them. */
const CLONE_PROTOCOLS = 'https:ssh';

/** How long a clone may take before it is ended and the crew fails. */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/** Where the trusted repositories are cloned, and the URL of each that is on the list now. */
export interface TrustedClones {
  readonly root: string;
  readonly urlOf: (repository: string) => string | undefined;
  /** The protocols a clone may use; https and ssh unless a test gives a file remote. */
  readonly protocols?: string;
}

export function createGitWorkspace(options: { configuration: TrierarchConfiguration; root: string; clones?: TrustedClones }): WorkspacePort {
  const { configuration, root, clones } = options;
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await runCommand('git', { args });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
  /** The remote branch for the ref when the remote has one, else the ref as it is. */
  const resolve = async (repository: string, ref: string): Promise<string> => {
    const remote = await runCommand('git', { args: ['-C', repository, 'rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${ref}`] });
    return remote.status === 0 ? `${REMOTE}/${ref}` : ref;
  };
  const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;
  const repositoryOf = async (folder: string): Promise<string | undefined> => {
    const [repository] = relative(root, folder).split(sep);
    if (repository === undefined) {
      return undefined;
    }
    const configured = configuration.repositories[repository]?.path;
    if (configured !== undefined || clones === undefined) {
      return configured;
    }
    // A clone whose repository left the trusted repositories still holds the worktrees made from it.
    const cloned = join(clones.root, repository);
    return (await exists(cloned)) ? cloned : undefined;
  };
  /** Clones a trusted repository into its path, whole or not at all, with the machine's own access. */
  const clone = async (at: { repository: string; path: string; url: string }): Promise<void> => {
    const partial = `${at.path}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(join(at.path, '..'), { recursive: true });
    const env: Record<string, string> = { GIT_ALLOW_PROTOCOL: clones?.protocols ?? CLONE_PROTOCOLS, GIT_TERMINAL_PROMPT: '0' };
    // Never wait on a passphrase or host key question nobody answers; an operator's own ssh command is kept.
    if (process.env.GIT_SSH_COMMAND === undefined) {
      env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    }
    const cloned = await runCommand('git', { args: ['clone', '--quiet', '--', at.url, partial], env, timeoutMs: CLONE_TIMEOUT_MS });
    if (cloned.status !== 0) {
      await rm(partial, { recursive: true, force: true });
      throw new Error(`git clone of ${at.repository} failed: ${cloned.stderr.trim() || `exit ${String(cloned.status)}`}`);
    }
    await rename(partial, at.path);
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
      const url = clones?.urlOf(workspace.repository);
      if (url !== undefined && !(await exists(repository))) {
        await clone({ repository: workspace.repository, path: repository, url });
      }
      const folder = join(root, workspace.repository, shipName);
      // A worktree a stop mid-crew left is used as it is.
      if (!(await exists(folder))) {
        await mkdir(join(root, workspace.repository), { recursive: true });
        await runCommand('git', { args: ['-C', repository, 'fetch', '--quiet', REMOTE] });
        await git(['-C', repository, 'worktree', 'add', '--detach', folder, ...(workspace.ref === undefined ? [] : [await resolve(repository, workspace.ref)])]);
      }
      return { folder };
    },
    isClean: async (folder) => (await git(['-C', folder, 'status', '--porcelain'])).trim() === '',
    unsaved: async (folder) => {
      const changes = await git(['-C', folder, 'status', '--porcelain']);
      const commits = await git(['-C', folder, 'log', '--format=commit %h %s', 'HEAD', '--not', '--branches', '--tags', '--remotes']);
      return [...changes.split('\n'), ...commits.split('\n')].filter((line) => line !== '');
    },
    remove: async (folder) => {
      const repository = await repositoryOf(folder);
      if (repository === undefined) {
        throw new Error(`${folder} is no worktree under ${root}: the trierarch removes only what it made`);
      }
      await git(['-C', repository, 'worktree', 'remove', '--force', folder]);
    },
    worktrees: async () => {
      const found: ObservedWorktree[] = [];
      for (const repository of await readdir(root).catch(() => [])) {
        for (const ship of await readdir(join(root, repository)).catch(() => [])) {
          found.push({ path: join(root, repository, ship), repository, name: ship });
        }
      }
      return found;
    },
  };
}
