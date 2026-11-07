import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A folder the host user cannot remove, as a session can leave one in its
 * clone or its ship's home: on Linux a folder owned by a mapped id, through
 * `podman unshare`, on macOS a file flagged immutable. Where neither can be
 * made, a test that needs one is skipped and says why.
 */
export const unremovableReason: string | undefined =
  process.platform === 'darwin' ? undefined : process.platform === 'linux' ? (spawnSync('podman', ['--version']).status === 0 ? undefined : 'needs podman to own a folder by a mapped id') : `no folder the host cannot remove is made on ${process.platform}`;

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  }
}

/** Makes `<folder>/a/f`, which the host user cannot remove. */
export function makeUnremovable(folder: string): void {
  const inner = join(folder, 'a');
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, 'f'), 'f\n');
  if (process.platform === 'darwin') {
    run('chflags', ['uchg', join(inner, 'f')]);
  } else {
    run('podman', ['unshare', 'chown', '-R', '1:1', inner]);
  }
}

/** Removes the path whatever makeUnremovable left in it, as the runtime's user namespace removes it. */
export function removeAsRuntime(path: string): Promise<void> {
  if (process.platform === 'darwin') {
    run('chflags', ['-R', 'nouchg', path]);
    rmSync(path, { recursive: true, force: true });
  } else {
    run('podman', ['unshare', 'rm', '-rf', '--', path]);
  }
  return Promise.resolve();
}
