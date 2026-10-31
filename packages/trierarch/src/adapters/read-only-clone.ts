import { rm, stat } from 'node:fs/promises';

import { runCommand } from './run-command.js';

/**
 * A read-only clone of a configured repository (#1182, aeolus-fleet#1449):
 * `--reference` with `--dissociate`, so it holds its own objects, on a local
 * branch main at the latest main, which it also keeps as `origin/main`, so a
 * session sees it on main with `HEAD` at `origin/main`. The repository is
 * fetched first, so main is its remote's when it has one, else its own. The
 * clone keeps no remote, so the session has none to push to, and no write
 * bit, so it changes and commits nothing; bringing it to main gives the write
 * bits back only meanwhile. A read-only checkout and a read-only workspace are
 * each one.
 */

const REMOTE = 'origin';
const MAIN = 'main';
/** Where a clone keeps the main it was last brought to. */
const FETCHED = `refs/remotes/${REMOTE}/${MAIN}`;

async function git(args: readonly string[]): Promise<string> {
  const result = await runCommand('git', { args });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function chmod(mode: string, path: string): Promise<void> {
  const result = await runCommand('chmod', { args: ['-R', mode, path] });
  if (result.status !== 0) {
    throw new Error(`chmod -R ${mode} ${path} failed: ${result.stderr.trim()}`);
  }
}

/**
 * The latest main of the repository: its remote's once fetched, when it has one, else its own.
 * A fetch that fails leaves what the repository has, unless the caller must have the remote's latest.
 */
async function latestMain(repository: string, { isFetchRequired }: { isFetchRequired: boolean }): Promise<string> {
  const hasRemote = (await runCommand('git', { args: ['-C', repository, 'remote', 'get-url', REMOTE] })).status === 0;
  const fetched = await runCommand('git', { args: ['-C', repository, 'fetch', '--quiet', REMOTE] });
  if (hasRemote && fetched.status !== 0 && isFetchRequired) {
    throw new Error(`git fetch ${REMOTE} in ${repository} failed: ${fetched.stderr.trim()}`);
  }
  const remote = await runCommand('git', { args: ['-C', repository, 'rev-parse', '--verify', '--quiet', FETCHED] });
  return remote.status === 0 ? FETCHED : `refs/heads/${MAIN}`;
}

/** Moves the clone to the latest main of its repository, writable only meanwhile: answers the revision it holds. */
export async function bringToMain(clone: { repository: string; path: string }, fetch: { isFetchRequired: boolean }): Promise<string> {
  const main = await latestMain(clone.repository, fetch);
  await chmod('u+w', clone.path);
  try {
    await git(['-C', clone.path, 'fetch', '--quiet', '--no-tags', clone.repository, `+${main}:${FETCHED}`]);
    await git(['-C', clone.path, 'checkout', '--quiet', '--force', '-B', MAIN, FETCHED]);
    return await git(['-C', clone.path, 'rev-parse', 'HEAD']);
  } finally {
    await chmod('a-w', clone.path);
  }
}

/** Makes a read-only clone of the repository at the path, at its latest main; a fetch that fails leaves what the repository has. */
export async function makeReadOnlyClone(clone: { repository: string; path: string }): Promise<void> {
  await git(['clone', '--quiet', '--no-checkout', '--reference', clone.repository, '--dissociate', clone.repository, clone.path]);
  await git(['-C', clone.path, 'remote', 'remove', REMOTE]);
  await bringToMain(clone, { isFetchRequired: false });
}

/** Removes a read-only clone, or a folder of them, giving its write bits back first. */
export async function removeReadOnly(path: string): Promise<void> {
  if ((await stat(path).catch(() => undefined)) !== undefined) {
    await chmod('u+w', path);
    await rm(path, { recursive: true, force: true });
  }
}
