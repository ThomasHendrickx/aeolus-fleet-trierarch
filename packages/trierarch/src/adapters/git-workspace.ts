import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { WorkspacePort } from '../core/ports.js';
import { foldersUnderRoot, isUnderRoot } from './folders-under-root.js';
import { gitInFolder, messageOf, RefusedRead } from './git-in-folder.js';
import { WORKTREE_FOLDER } from './paths.js';
import { type CommandResult, runCommand } from './run-command.js';
import { discard, type MoveWithinUserNamespace } from './trash.js';
import { clonedPath, cloneWhenMissing, type TrustedClones } from './trusted-clones.js';

/**
 * Workspaces (docs/architecture.md, "First adapters"): a git worktree of a
 * configured repository in the ship's own folder (`<ships>/<shipId>/worktree`),
 * or for a ship crewed before the ship folders under the worktree root it was
 * made in (`<root>/<repository>/<ship>`), detached at the settings' ref or the
 * repository's HEAD; or a configured folder used as it is. A ship's folder goes
 * whole into the trash beside it, whatever it holds. The repository is
 * fetched first, and a ref the remote has a branch for is that remote branch,
 * so a ship starts from current code, not from a stale local branch. A fetch
 * that fails (offline, no remote) leaves what the repository has.
 * A trusted repository the machine does not have yet is cloned first
 * (aeolus-fleet#384). Any folder under either root is listed and removed,
 * whatever made it (gap rule 2); nothing outside them. In a configured
 * repository's checkout, a local branch checked out in no worktree whose
 * remote branch the remote no longer has is deleted (gap rule 5).
 */

const REMOTE = 'origin';

/** How long reading a remote's branches may take before the pass goes on without deleting a branch. */
const REMOTE_READ_TIMEOUT_MS = 60_000;

/** What a folder the host does not read holds, as unsaved: not known, so it is told with why, never taken for clean. */
export const REFUSED_PREFIX = 'refused, ';

/** A ship's folder's mode: only its owner opens it. */
const SHIP_FOLDER_MODE = 0o700;

/** Where the places of the workspaces are: the place of ships/, and the worktree root of the ships crewed before the ship folders. */
export interface WorkspaceRoots {
  /** The place of every ship's folder, `<root>/<shipId>/`; a configured one holds the worktrees of the ships crewed before the ship folders too. */
  readonly root: string;
  /** The worktree root of the ships crewed before the ship folders, where their worktrees stay until they are crewed fresh, when it is not the root. */
  readonly before?: string;
}

/** The roots a workspace could be under: the place of ships/, and the worktree root of the ships crewed before. */
export function rootsOf(at: WorkspaceRoots): readonly string[] {
  return at.before === undefined || at.before === at.root ? [at.root] : [at.root, at.before];
}

/** Where the ship's worktree or clone is made: in its ship's folder, or with none under the worktree root of the ships crewed before by its name. */
export function workspaceFolderOf(at: WorkspaceRoots & { repository: string; shipName: string; shipFolder?: string }): string {
  return at.shipFolder === undefined ? join(at.before ?? at.root, at.repository, at.shipName) : join(at.shipFolder, WORKTREE_FOLDER);
}

/** Makes the folder the worktree or clone is made in: the ship's folder for its owner alone, or the repository's under its root. */
export async function makeParentOf(folder: string, shipFolder: string | undefined): Promise<void> {
  if (shipFolder === undefined) {
    await mkdir(dirname(folder), { recursive: true });
    return;
  }
  await mkdir(dirname(shipFolder), { recursive: true });
  await mkdir(shipFolder, { recursive: true, mode: SHIP_FOLDER_MODE });
}

/** Moves the ship's folder into the trash beside it, at once, so nothing reads it again; one already gone is removed already. Its worktree's record in its repository goes with the next prune. */
export async function removeShipFolder(shipFolder: string, withinUserNamespace?: MoveWithinUserNamespace): Promise<void> {
  if ((await lstat(shipFolder).catch(() => undefined)) === undefined) {
    return;
  }
  await discard(shipFolder, { at: new Date(), ...(withinUserNamespace !== undefined && { withinUserNamespace }) });
}

export function createGitWorkspace(
  options: {
    configuration: TrierarchConfiguration;
    clones?: TrustedClones;
    /** Git in a ship's folder; a worktree's, unless the workspaces are clones. */
    inFolder?: (folder: string, args: readonly string[]) => Promise<CommandResult>;
  } & WorkspaceRoots,
): WorkspacePort {
  const { configuration, root, clones, inFolder = gitInFolder } = options;
  const roots = rootsOf(options);
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
  /** Whether git lists the folder as a worktree of the repository; it lists real paths, so a root reached over a link is compared by its real path too. */
  const isWorktreeOf = async (repository: string, folder: string): Promise<boolean> => {
    const listed = await runCommand('git', { args: ['-C', repository, 'worktree', 'list', '--porcelain'] });
    if (listed.status !== 0) {
      return false;
    }
    const known = new Set(listed.stdout.split('\n').flatMap((line) => (line.startsWith('worktree ') ? [line.slice('worktree '.length)] : [])));
    return known.has(folder) || known.has(await realpath(folder).catch(() => folder));
  };
  const repositoryOf = async (folder: string): Promise<string | undefined> => {
    const inRoot = roots.map((each) => relative(each, folder)).find((path) => path !== '' && !path.startsWith('..') && !isAbsolute(path));
    const [repository] = inRoot?.split(sep) ?? [];
    if (repository === undefined) {
      return undefined;
    }
    // A clone whose repository left the trusted repositories still holds the worktrees made from it.
    return configuration.repositories[repository]?.path ?? (await clonedPath(clones, repository));
  };
  /** Whether the name is a repository it has, whose own folder under the root is the layout's. */
  const isRepository = async (name: string): Promise<boolean> => configuration.repositories[name] !== undefined || (await clonedPath(clones, name)) !== undefined;

  return {
    shipFolderOf: (shipId) => Promise.resolve(join(root, shipId)),
    prepare: async ({ shipName, workspace, shipFolder }) => {
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
      const folder = workspaceFolderOf({ ...options, repository: workspace.repository, shipName, ...(shipFolder !== undefined && { shipFolder }) });
      // A worktree a stop mid-crew left is used as it is.
      if (!(await exists(folder))) {
        await makeParentOf(folder, shipFolder);
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
    remove: async (folder) => {
      if (!(await isUnderRoot(roots, folder))) {
        throw new Error(`${folder} is not under ${roots.join(' or ')}, or is its trash: the trierarch removes only a folder under the root`);
      }
      const repository = await repositoryOf(folder);
      if (repository !== undefined && (await isWorktreeOf(repository, folder))) {
        await git(['-C', repository, 'worktree', 'remove', '--force', folder]);
        return;
      }
      // Anything else under the root goes as it is: a plain clone, a worktree of another repository, a folder git does not know.
      const found = await lstat(folder).catch(() => undefined);
      if (found === undefined) {
        return;
      }
      if (!found.isDirectory()) {
        throw new Error(`${folder} is no folder: the trierarch removes only a folder under the root`);
      }
      await rm(folder, { recursive: true, force: true });
    },
    removeShipFolder: async (shipFolder) => removeShipFolder(shipFolder),
    prune: async (repository) => {
      const path = configuration.repositories[repository]?.path;
      if (path === undefined) {
        throw new Error(`The configuration has no repository ${repository}`);
      }
      await git(['-C', path, 'worktree', 'prune']);
    },
    deleteBranchesWhoseRemoteBranchIsGone: async (repository) => {
      const path = configuration.repositories[repository]?.path;
      if (path === undefined) {
        throw new Error(`The configuration has no repository ${repository}`);
      }
      const listed = await git(['-C', path, 'for-each-ref', '--format=%(refname)%00%(worktreepath)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads']);
      // A branch with no remote branch, or one a worktree has checked out, stays.
      const tracking = listed.split('\n').flatMap((line) => {
        const [ref = '', worktree = '', remote = '', remoteRef = ''] = line.split('\0');
        return ref.startsWith('refs/heads/') && worktree === '' && remote !== '' && remote !== '.' && remoteRef !== '' ? [{ branch: ref.slice('refs/heads/'.length), remote, remoteRef }] : [];
      });
      const remoteRefs = new Map<string, ReadonlySet<string>>();
      for (const remote of new Set(tracking.map((found) => found.remote))) {
        // Every remote is read before anything is deleted: one that cannot be read takes no branch for gone.
        const args = ['-C', path, 'ls-remote', '--heads', remote];
        const heads = said(args, await runCommand('git', { args, env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: REMOTE_READ_TIMEOUT_MS }));
        remoteRefs.set(remote, new Set(heads.split('\n').flatMap((line) => line.split('\t').slice(1))));
      }
      for (const { branch, remote, remoteRef } of tracking) {
        if (remoteRefs.get(remote)?.has(remoteRef) === false) {
          await git(['-C', path, 'branch', '-D', branch]);
        }
      }
    },
    foldersUnderRoot: async () => foldersUnderRoot(roots, isRepository),
  };
}
