import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PUBLISHED_PACKAGES } from './set-version.ts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const packResultSchema = z.array(z.object({ files: z.array(z.object({ path: z.string() })) })).length(1);

/** The paths npm would put in the package's tarball. */
function tarballFiles(name: string): string[] {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--workspace', `@aeolus-fleet/${name}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const [result] = packResultSchema.parse(JSON.parse(output));
  return result?.files.map((file) => file.path) ?? [];
}

describe.each(PUBLISHED_PACKAGES)('the published package %s', (name) => {
  it('ships the LICENSE', { timeout: 30_000 }, () => {
    expect(tarballFiles(name)).toContain('LICENSE');
  });
});
