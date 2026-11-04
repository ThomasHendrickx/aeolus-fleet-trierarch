import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isTodaysTrierarch } from './trierarch-under-test.js';

/** Builds today's trierarch once before the suite, as `npm install --global` would install it; another trierarch under test comes built. */
export function setup(): void {
  if (isTodaysTrierarch) {
    execFileSync('npm', ['run', 'build'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: 'inherit' });
  }
}
