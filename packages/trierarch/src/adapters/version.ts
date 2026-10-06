import { readFileSync } from 'node:fs';

import { z } from 'zod';

const packageJson = z.object({ version: z.string() });

/**
 * The version this trierarch runs, read from its package.json: what runs, not
 * what was meant to ship. This file sits at src/adapters or dist/adapters: the
 * package root is two levels up.
 */
export function runningVersion(): string {
  return packageJson.parse(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))).version;
}
