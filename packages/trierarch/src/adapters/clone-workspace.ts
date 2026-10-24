import { mkdir, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { WorkspacePort } from '../core/ports.js';
import { createGitWorkspace } from './git-workspace.js';
import { runCommand } from './run-command.js';
import { clonedPath, cloneWhenMissing, type TrustedClones } from './trusted-clones.js';

/**
 * Workspaces for sessions in containers (decision 0039; trierarch.md, "Session
 * runtime"): a per-ship clone of a configured repository in place of a
 * worktree, at the same path (`<root>/<repository>/<ship>`). A worktree points
 * into the repository's `.git`, its hooks and every other ship's worktree data;
 * a clone has a `.git` of its own. `--reference` with `--dissociate` borrows
 * the repository's objects only while cloning, so the clone holds its own and
 * no gc of the repository can break it. Its origin is the repository's own
 * remote, so the session pushes without the host, with the remote branches as
 * the repository last fetched them; a repository with no remote leaves the
 * clone with none. The ref resolves as a worktree's does. A configured folder,
 * cleanliness, what removing discards and the listing are a worktree's.
 */

const REMOTE = 'origin';
export function createCloneWorkspace(options: { configuration: TrierarchConfiguration; root: string; clones?: TrustedClones }): WorkspacePort {
  const { configuration, root, clones } = options;
  const worktrees = createGitWorkspace(options);
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await runCommand('git', { args });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
  /** The commit of the remote branch for the ref when the remote has one, else of the ref as it is, or of HEAD with none. */
  const resolve = async (repository: string, ref: string | undefined): Promise<string> => {
    if (ref === undefined) {
      return (await git(['-C', repository, 'rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    }
    const remote = await runCommand('git', { args: ['-C', repository, 'rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${ref}^{commit}`] });
    return remote.status === 0 ? remote.stdout.trim() : (await git(['-C', repository, 'rev-parse', '--verify', `${ref}^{commit}`])).trim();
  };
  const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;
  const isUnderRoot = async (folder: string): Promise<boolean> => {
    const [repository, ship, ...rest] = relative(root, folder).split(sep);
    if (repository === undefined || ship === undefined || rest.length > 0 || ship === '' || ship === '..') {
      return false;
    }
    // A clone whose repository left the trusted repositories is still one the trierarch made.
    return configuration.repositories[repository] !== undefined || (await clonedPath(clones, repository)) !== undefined;
  };

  return {
    ...worktrees,
    prepare: async (request) => {
      const { shipName, workspace } = request;
      if (workspace.kind === 'folder') {
        return worktrees.prepare(request);
      }
      const repository = configuration.repositories[workspace.repository]?.path;
      if (repository === undefined) {
        throw new Error(`The configuration has no repository ${workspace.repository}`);
      }
      await cloneWhenMissing(clones, { repository: workspace.repository, path: repository });
      const folder = join(root, workspace.repository, shipName);
      // A clone a stop mid-crew left is used as it is.
      if (!(await exists(folder))) {
        await mkdir(join(root, workspace.repository), { recursive: true });
        await runCommand('git', { args: ['-C', repository, 'fetch', '--quiet', REMOTE] });
        const commit = await resolve(repository, workspace.ref);
        await git(['clone', '--quiet', '--no-checkout', '--reference', repository, '--dissociate', repository, folder]);
        // The clone's origin is the repository's checkout, whose branches are no remote's: dropped with it.
        await git(['-C', folder, 'remote', 'remove', REMOTE]);
        const remote = await runCommand('git', { args: ['-C', repository, 'remote', 'get-url', REMOTE] });
        if (remote.status === 0) {
          await git(['-C', folder, 'remote', 'add', REMOTE, remote.stdout.trim()]);
          await git(['-C', folder, 'fetch', '--quiet', '--no-tags', repository, `+refs/remotes/${REMOTE}/*:refs/remotes/${REMOTE}/*`]);
        }
        await git(['-C', folder, 'checkout', '--quiet', '--detach', commit]);
      }
      return { folder };
    },
    remove: async (folder) => {
      if (!(await isUnderRoot(folder))) {
        throw new Error(`${folder} is no clone under ${root}: the trierarch removes only what it made`);
      }
      await rm(folder, { recursive: true, force: true });
    },
  };
}
