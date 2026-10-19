import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A throwaway git repository for testing the checks against real commits. */
export interface TemporaryRepository {
  path: string;
  /** Writes a file, creating its folders. */
  write(file: string, content: string): void;
  remove(file: string): void;
  /** Commits everything in the working tree and returns the commit's hash. */
  commit(message: string): string;
  git(args: readonly string[]): string;
  dispose(): void;
}

export function createTemporaryRepository(): TemporaryRepository {
  const path = mkdtempSync(join(tmpdir(), 'aeolus-check-'));
  // Isolated from the machine's git configuration, commit signing included.
  // No automatic maintenance: a commit would start it detached, still working
  // in the repository after the commit returned, so removing the repository
  // would race it (#335).
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'maintenance.auto',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'gc.auto',
    GIT_CONFIG_VALUE_1: '0',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args: readonly string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8', env });

  git(['init', '--quiet', '--initial-branch=main']);

  return {
    path,
    write: (file, content) => {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), content);
    },
    remove: (file) => {
      rmSync(join(path, file));
    },
    commit: (message) => {
      git(['add', '--all']);
      git(['commit', '--quiet', '--allow-empty', '--message', message]);
      return git(['rev-parse', 'HEAD']).trim();
    },
    git,
    dispose: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
