import { existsSync, readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

it('releases the binary and session image without publishing a TypeScript package', () => {
  const root = new URL('../', import.meta.url);
  expect(existsSync(new URL('packages/trierarch', root))).toBe(false);
  expect(existsSync(new URL('image/Containerfile', root))).toBe(true);
  const release = readFileSync(new URL('.github/workflows/release.yml', root), 'utf8');
  expect(release).not.toMatch(/npm publish|npm pack|npm view/);
  expect(release).toContain('go-binaries.yml');
  expect(release).toContain('podman push');
});
