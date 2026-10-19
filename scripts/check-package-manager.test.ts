import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageManagerProblems } from './check-package-manager.ts';
import { createTemporaryRepository, type TemporaryRepository } from './support/temporary-repository.ts';

let repository: TemporaryRepository;

beforeEach(() => {
  repository = createTemporaryRepository();
});

afterEach(() => {
  repository.dispose();
});

function manifest(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ name: 'aeolus-fleet-trierarch', private: true, ...fields }, null, 2)}\n`;
}

describe('the npm-only check', () => {
  it('passes npm as the package manager with its lockfile', () => {
    repository.write('package.json', manifest({ packageManager: 'npm@11.19.1' }));
    repository.write('package-lock.json', '{}\n');
    repository.commit('chore: npm');

    expect(packageManagerProblems(repository.path)).toEqual([]);
  });

  it.each(['pnpm-lock.yaml', 'yarn.lock', 'packages/trierarch/yarn.lock'])('refuses a tracked %s', (lockfile) => {
    repository.write('package.json', manifest({ packageManager: 'npm@11.19.1' }));
    repository.write(lockfile, '');
    repository.commit('chore: another lockfile');

    expect(packageManagerProblems(repository.path)).toEqual([
      `${lockfile} belongs to another package manager: use npm only`,
    ]);
  });

  it('refuses a package.json without packageManager', () => {
    repository.write('package.json', manifest({}));
    repository.commit('chore: no package manager');

    expect(packageManagerProblems(repository.path)).toEqual([expect.stringContaining('sets packageManager to npm')]);
  });

  it.each(['pnpm@10.0.0', 'yarn@4.5.0', 'npm', 'npm@latest'])('refuses packageManager %s', (packageManager) => {
    repository.write('package.json', manifest({ packageManager }));
    repository.commit('chore: another package manager');

    expect(packageManagerProblems(repository.path)).toEqual([expect.stringContaining(`not ${packageManager}`)]);
  });
});
