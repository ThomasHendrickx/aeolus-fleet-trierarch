import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { runCommand } from './run-command.js';

/**
 * The clones of trusted repositories (aeolus-fleet#384): a trusted repository
 * the machine does not have yet is cloned once, before its first workspace,
 * with the machine's own access: over https or ssh only, never asking for a
 * password, into a partial folder renamed into place whole, so a stop
 * mid-clone leaves no half clone to crew from.
 */

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

const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;

/** Clones the repository into its path when it is on the list and the machine does not have it yet. */
export async function cloneWhenMissing(clones: TrustedClones | undefined, at: { repository: string; path: string }): Promise<void> {
  const url = clones?.urlOf(at.repository);
  if (url === undefined || (await exists(at.path))) {
    return;
  }
  const partial = `${at.path}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(join(at.path, '..'), { recursive: true });
  const env: Record<string, string> = { GIT_ALLOW_PROTOCOL: clones?.protocols ?? CLONE_PROTOCOLS, GIT_TERMINAL_PROMPT: '0' };
  // Never wait on a passphrase or host key question nobody answers; an operator's own ssh command is kept.
  if (process.env.GIT_SSH_COMMAND === undefined) {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  }
  const cloned = await runCommand('git', { args: ['clone', '--quiet', '--', url, partial], env, timeoutMs: CLONE_TIMEOUT_MS });
  if (cloned.status !== 0) {
    await rm(partial, { recursive: true, force: true });
    throw new Error(`git clone of ${at.repository} failed: ${cloned.stderr.trim() || `exit ${String(cloned.status)}`}`);
  }
  await rename(partial, at.path);
}

/** The clone of a repository that left the trusted repositories, which still holds the workspaces made from it; none when there is none. */
export async function clonedPath(clones: TrustedClones | undefined, repository: string): Promise<string | undefined> {
  if (clones === undefined) {
    return undefined;
  }
  const cloned = join(clones.root, repository);
  return (await exists(cloned)) ? cloned : undefined;
}
