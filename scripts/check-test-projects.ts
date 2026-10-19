/**
 * CI check: Vitest runs every test file. Each *.test.ts or *.test.tsx that git
 * tracks must match a project in vitest.config.ts, so no test is written and
 * then never run. Vitest itself decides what a project matches.
 *
 * Usage: node scripts/check-test-projects.ts
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import { createVitest } from 'vitest/node';

import { repositoryRoot, trackedFiles } from './support/git.ts';
import { report } from './support/report.ts';

const TEST_FILE = /\.test\.tsx?$/;

export async function testProjectProblems(repository: string): Promise<string[]> {
  // Vitest resolves symbolic links in its root (macOS's temporary folder is one), so the files are matched by the same real path.
  const root = realpathSync(repository);
  const vitest = await createVitest({ root, watch: false });
  try {
    return trackedFiles(root)
      .filter((file) => TEST_FILE.test(file))
      .filter((file) => !vitest.projects.some((project) => project.matchesTestGlob(join(root, file))))
      .map((file) => `${file} matches no Vitest project, so it never runs`);
  } finally {
    await vitest.close();
  }
}

if (import.meta.main) {
  report({ name: 'Every test runs', problems: await testProjectProblems(repositoryRoot) });
}
