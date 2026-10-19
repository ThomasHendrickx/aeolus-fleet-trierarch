import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from './temporary-repository.ts';

// A commit may start git's automatic maintenance, which detaches and goes on
// working in the repository after the commit returned (it holds
// .git/objects/maintenance.lock). Removing the repository then races it and
// fails with ENOTEMPTY (#335).

const traces: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const trace of traces.splice(0)) {
    rmSync(trace, { recursive: true, force: true });
  }
});

/** Every git command the repository runs, as git's trace records them. */
function traced(): { trace: () => string } {
  const folder = mkdtempSync(join(tmpdir(), 'aeolus-trace-'));
  traces.push(folder);
  const file = join(folder, 'git.trace');
  vi.stubEnv('GIT_TRACE', file);
  return { trace: () => readFileSync(file, 'utf8') };
}

describe('a temporary repository', () => {
  it('starts no automatic maintenance on a commit, so nothing is left working in it when it is removed', () => {
    const { trace } = traced();
    const repository = createTemporaryRepository();
    repository.write('a.txt', 'a\n');
    repository.commit('chore: a');
    repository.dispose();

    expect(trace()).toContain('commit');
    expect(trace()).not.toContain('maintenance');
  });
});
