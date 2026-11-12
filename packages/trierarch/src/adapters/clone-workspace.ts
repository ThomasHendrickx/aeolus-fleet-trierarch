import { lstat, realpath, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { WorkspacePort } from '../core/ports.js';
import { foldersUnderRoot, isUnderRoot } from './folders-under-root.js';
import { gitInCloneWithin, gitInFreshClone, type Limits } from './git-in-folder.js';
import { createGitWorkspace, makeParentOf, REFUSED_PREFIX, removeShipFolder, rootsOf, workspaceFolderOf, type WorkspaceRoots } from './git-workspace.js';
import { runCommand } from './run-command.js';
import { discard, type MoveWithinUserNamespace } from './trash.js';
import { clonedPath, cloneWhenMissing, type TrustedClones } from './trusted-clones.js';

/**
 * Workspaces for sessions in containers (decision 0039; trierarch.md, "Session
 * runtime"): a per-ship clone of a configured repository in place of a
 * worktree, at the same path (`<ships>/<shipId>/worktree`, or for a ship
 * crewed before the ship folders `<root>/<repository>/<ship>`). A worktree points
 * into the repository's `.git`, its hooks and every other ship's worktree data;
 * a clone has a `.git` of its own. `--reference` with `--dissociate` borrows
 * the repository's objects only while cloning, so the clone holds its own and
 * no gc of the repository can break it. Its origin is the repository's own
 * remote, so the session pushes without the host, with the remote branches as
 * the repository last fetched them; a repository with no remote leaves the
 * clone with none. The ref resolves as a worktree's does. A configured folder,
 * cleanliness, what removing discards and the listing are a worktree's, but a
 * clone whose read fails in any way is not clean and is unsaved, saying why,
 * so its release tells argo and removes it.
 */

const REMOTE = 'origin';

export function createCloneWorkspace(options: { configuration: TrierarchConfiguration; clones?: TrustedClones; moveWithinUserNamespace?: MoveWithinUserNamespace } & WorkspaceRoots & Limits): WorkspacePort {
  const { configuration, root, before, clones } = options;
  const roots = rootsOf(options);
  const limits: Limits = options.timeLimitMs === undefined ? {} : { timeLimitMs: options.timeLimitMs };
  const gitInClone = gitInCloneWithin(limits);
  const worktrees = createGitWorkspace({ configuration, root, ...(before !== undefined && { before }), ...(clones !== undefined && { clones }), inFolder: gitInClone });
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await runCommand('git', { args });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
  /** Git in the ship's fresh clone, which ignores the clone's own config where it names a program, through the clone's own `.git`, and runs the machine's own filters. */
  const gitIn = async (clone: string, args: readonly string[]): Promise<void> => {
    const result = await gitInFreshClone(clone, args);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
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
  /** Whether the name is a repository it has, whose own folder under the root is the layout's; a clone whose repository left the trusted repositories is still one. */
  const isRepository = async (name: string): Promise<boolean> => configuration.repositories[name] !== undefined || (await clonedPath(clones, name)) !== undefined;
  return {
    ...worktrees,
    // What a clone holds is not known when any read of it fails, so it is not clean.
    isClean: async (folder) => worktrees.isClean(folder).catch(() => false),
    // What a clone holds is not known when any read of it fails: told with why, as one the host does not read.
    unsaved: async (folder) => worktrees.unsaved(folder).catch((error: unknown) => [`${REFUSED_PREFIX}${error instanceof Error ? error.message : String(error)}`]),
    prepare: async (request) => {
      const { shipName, workspace, shipFolder } = request;
      if (workspace.kind === 'folder') {
        return worktrees.prepare(request);
      }
      const repository = configuration.repositories[workspace.repository]?.path;
      if (repository === undefined) {
        throw new Error(`The configuration has no repository ${workspace.repository}`);
      }
      await cloneWhenMissing(clones, { repository: workspace.repository, path: repository });
      const folder = workspaceFolderOf({ ...options, repository: workspace.repository, shipName, ...(shipFolder !== undefined && { shipFolder }) });
      // A clone a stop mid-crew left is used as it is.
      if (!(await exists(folder))) {
        await makeParentOf(folder, shipFolder);
        await runCommand('git', { args: ['-C', repository, 'fetch', '--quiet', REMOTE] });
        const commit = await resolve(repository, workspace.ref);
        try {
          await git(['clone', '--quiet', '--no-checkout', '--reference', repository, '--dissociate', repository, folder]);
          // The clone's origin is the repository's checkout, whose branches are no remote's: dropped with it.
          await gitIn(folder, ['remote', 'remove', REMOTE]);
          const remote = await runCommand('git', { args: ['-C', repository, 'remote', 'get-url', REMOTE] });
          if (remote.status === 0) {
            await gitIn(folder, ['remote', 'add', REMOTE, remote.stdout.trim()]);
            await gitIn(folder, ['fetch', '--quiet', '--no-tags', repository, `+refs/remotes/${REMOTE}/*:refs/remotes/${REMOTE}/*`]);
          }
          await gitIn(folder, ['checkout', '--quiet', '--detach', commit]);
        } catch (error) {
          await rm(folder, { recursive: true, force: true });
          throw error;
        }
      }
      return { folder };
    },
    remove: async (folder) => {
      if (!(await isUnderRoot(roots, folder))) {
        throw new Error(`${folder} is not under ${roots.join(' or ')}, or is its trash: the trierarch removes only a folder under the root`);
      }
      // One already gone is removed already.
      if ((await lstat(folder).catch(() => undefined)) === undefined) {
        return;
      }
      // One straight under the worktree root of the ships crewed before has no trash beside it a pass empties, and no session ran in it, so the host removes it; one straight under the place of ships/, a ship's folder among them, goes into the trash beside it.
      if (before !== undefined && before !== root && [before, await realpath(before).catch(() => before)].includes(dirname(folder))) {
        await worktrees.remove(folder);
        return;
      }
      // Aside at once, so its ship's place is free and nothing reads it again; the trash removes it (docs/trierarch.md, "Session runtime").
      await discard(folder, { at: new Date(), ...(options.moveWithinUserNamespace !== undefined && { withinUserNamespace: options.moveWithinUserNamespace }) });
    },
    removeShipFolder: async (shipFolder) => removeShipFolder(shipFolder, options.moveWithinUserNamespace),
    foldersUnderRoot: async () => foldersUnderRoot(roots, isRepository),
  };
}
