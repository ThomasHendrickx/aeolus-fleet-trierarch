import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';

import type { Checkout, CheckoutsPort, RefreshedCheckout } from '../core/ports.js';
import type { TrierarchConfiguration } from './files.js';
import { runCommand } from './run-command.js';

/**
 * Read-only checkouts in git (#1182; docs/trierarch.md, "Read-only
 * checkouts"): per ship, `<root>/<ship id>/<repository>`, a clone of the
 * configured repository (`--reference` with `--dissociate`, so it holds its
 * own objects, as a container's workspace does) on a local branch main at the
 * latest main, which it also keeps as `origin/main`, so a session sees it on
 * main with `HEAD` at `origin/main` (aeolus-fleet#1449). The configured
 * repository is fetched first, so main is its remote's when it has one, else
 * its own; a refresh whose fetch fails answers a problem rather than the main
 * it held. The clone keeps no remote, so the session has none to push to, and
 * no write bit, so it changes and commits nothing; a refresh gives the write
 * bits back only while it moves the checkout on.
 */

const REMOTE = 'origin';
const MAIN = 'main';
/** Where a checkout keeps the main it was last brought to. */
const FETCHED = `refs/remotes/${REMOTE}/${MAIN}`;

export function createGitCheckouts(options: { configuration: TrierarchConfiguration; root: string }): CheckoutsPort {
  const { configuration, root } = options;
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await runCommand('git', { args });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  };
  const chmod = async (mode: string, path: string): Promise<void> => {
    const result = await runCommand('chmod', { args: ['-R', mode, path] });
    if (result.status !== 0) {
      throw new Error(`chmod -R ${mode} ${path} failed: ${result.stderr.trim()}`);
    }
  };
  const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;
  const pathOf = (repository: string): string => {
    const path = configuration.repositories[repository]?.path;
    if (path === undefined) {
      throw new Error(`The configuration has no repository ${repository}`);
    }
    return path;
  };
  /**
   * The latest main of the repository: its remote's once fetched, when it has one, else its own.
   * A fetch that fails leaves what the repository has, unless the caller must have the remote's latest.
   */
  const latestMain = async (repository: string, { isFetchRequired }: { isFetchRequired: boolean }): Promise<string> => {
    const hasRemote = (await runCommand('git', { args: ['-C', repository, 'remote', 'get-url', REMOTE] })).status === 0;
    const fetched = await runCommand('git', { args: ['-C', repository, 'fetch', '--quiet', REMOTE] });
    if (hasRemote && fetched.status !== 0 && isFetchRequired) {
      throw new Error(`git fetch ${REMOTE} in ${repository} failed: ${fetched.stderr.trim()}`);
    }
    const remote = await runCommand('git', { args: ['-C', repository, 'rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${MAIN}`] });
    return remote.status === 0 ? `refs/remotes/${REMOTE}/${MAIN}` : `refs/heads/${MAIN}`;
  };
  /** Moves the checkout to the latest main of its repository, writable only meanwhile: answers the revision it holds. */
  const bringToMain = async (checkout: Checkout, fetch: { isFetchRequired: boolean }): Promise<string> => {
    const repository = pathOf(checkout.repository);
    const main = await latestMain(repository, fetch);
    await chmod('u+w', checkout.path);
    try {
      await git(['-C', checkout.path, 'fetch', '--quiet', '--no-tags', repository, `+${main}:${FETCHED}`]);
      await git(['-C', checkout.path, 'checkout', '--quiet', '--force', '-B', MAIN, FETCHED]);
      return await git(['-C', checkout.path, 'rev-parse', 'HEAD']);
    } finally {
      await chmod('a-w', checkout.path);
    }
  };

  return {
    prepare: async ({ shipId, repository }) => {
      const made: Checkout[] = [];
      for (const checkout of configuration.repositories[repository]?.checkouts ?? []) {
        const path = join(root, shipId, checkout);
        // A checkout the ship has already stays as it is: only a refresh moves it on.
        if (!(await exists(path))) {
          await mkdir(join(root, shipId), { recursive: true });
          const source = pathOf(checkout);
          await git(['clone', '--quiet', '--no-checkout', '--reference', source, '--dissociate', source, path]);
          await git(['-C', path, 'remote', 'remove', REMOTE]);
          await bringToMain({ repository: checkout, path }, { isFetchRequired: false });
        }
        made.push({ repository: checkout, path });
      }
      return made;
    },
    refresh: async (shipId: ShipId) => {
      const refreshed: RefreshedCheckout[] = [];
      for (const repository of (await readdir(join(root, shipId)).catch(() => [])).toSorted()) {
        try {
          refreshed.push({ repository, revision: await bringToMain({ repository, path: join(root, shipId, repository) }, { isFetchRequired: true }) });
        } catch (error) {
          refreshed.push({ repository, problem: (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '' });
        }
      }
      return refreshed;
    },
    remove: async (shipId) => {
      const path = join(root, shipId);
      if (await exists(path)) {
        await chmod('u+w', path);
        await rm(path, { recursive: true, force: true });
      }
    },
  };
}
