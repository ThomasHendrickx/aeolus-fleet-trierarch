/**
 * CI check: npm is the only package manager (CLAUDE.md, "House rules"). No
 * lockfile of another package manager is tracked, and package.json names npm
 * as its packageManager.
 *
 * Usage: node scripts/check-package-manager.ts
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { repositoryRoot, trackedFiles } from './support/git.ts';
import { report } from './support/report.ts';

export const FOREIGN_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock'];

const NPM_PACKAGE_MANAGER = /^npm@\d+\.\d+\.\d+$/;

export function packageManagerProblems(repository: string): string[] {
  const lockfiles = trackedFiles(repository)
    .filter((file) => FOREIGN_LOCKFILES.includes(basename(file)))
    .map((file) => `${file} belongs to another package manager: use npm only`);

  const manifest: unknown = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  const packageManager =
    typeof manifest === 'object' && manifest !== null && 'packageManager' in manifest
      ? manifest.packageManager
      : undefined;
  const declared =
    typeof packageManager === 'string' && NPM_PACKAGE_MANAGER.test(packageManager)
      ? []
      : [`package.json sets packageManager to npm with its version, like "npm@11.5.1", not ${String(packageManager)}`];

  return [...lockfiles, ...declared];
}

if (import.meta.main) {
  report({ name: 'npm only', problems: packageManagerProblems(repositoryRoot) });
}
