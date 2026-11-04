import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Builds today's trierarch once before the suite, as `npm install --global` would install it: the trierarch under test when no other is named, and the one another takes over holds from and gives them to. Another trierarch under test comes built. */
export function setup(): void {
  execFileSync('npm', ['run', 'build'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: 'inherit' });
}
