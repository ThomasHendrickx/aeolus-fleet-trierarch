import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** The root of this repository, where the checks run from CI. */
export const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Runs git in a repository and returns what it printed. Throws when git fails. */
export function git(repository: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
}

/** A pull request's commits: reachable from its head, not from its base. */
export interface PullRequestRange {
  base: string;
  head: string;
}

/** The files git tracks in the repository, relative to its root. */
export function trackedFiles(repository: string): string[] {
  return git(repository, ['ls-files', '-z']).split('\0').filter(Boolean);
}
