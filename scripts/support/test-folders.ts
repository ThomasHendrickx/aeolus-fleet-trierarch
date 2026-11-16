import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A run folder untouched for this long belongs to a run that was killed. */
const STALE_AFTER_MS = 24 * 3_600_000;

const RUN_MARKER = 'TRIERARCH_TEST_RUN';
/** Names the short run folder, for what needs a short path (a Unix socket's is at most 104 bytes on macOS). */
export const SHORT_FOLDER_VARIABLE = 'TRIERARCH_TEST_SHORT_FOLDER';

export interface TestFolders {
  readonly repositoryRoot: string;
  readonly home: string;
  readonly now: Date;
  /** The environment to set TMPDIR in: process.env for a run. */
  readonly env: Record<string, string | undefined>;
}

/**
 * Makes the folders one test run makes its temporary folders in, and points
 * TMPDIR at the first, so every `os.tmpdir()` of the run lands there and
 * nothing is left in the operating system's temporary folder: a run folder
 * of the repository's ignored cache, and a short one under the home (`.tt`, as short as a ship's socket path needs), named by
 * TRIERARCH_TEST_SHORT_FOLDER. Removes the run folders older than 24 hours
 * first, so a killed run leaves nothing for long. Returns what ends the run:
 * it removes both folders. Called again within the run (each project's global
 * setup calls it), it reuses the run's folders and its end removes nothing.
 */
export function startTestFolders(at: TestFolders): () => void {
  const { env } = at;
  if (env[RUN_MARKER] !== undefined) {
    return () => undefined;
  }
  const bases = [join(at.repositoryRoot, 'node_modules', '.cache', 'trierarch-tests'), join(at.home, '.tt')];
  for (const base of bases) {
    removeStale(base, at.now);
  }
  // Four characters: a ship's socket path, in the short folder, is at most 104 bytes on macOS.
  const run = randomBytes(2).toString('hex');
  const [long = '', short = ''] = bases.map((base) => join(base, run));
  for (const folder of [long, short]) {
    mkdirSync(folder, { recursive: true });
  }
  const before = env.TMPDIR;
  env.TMPDIR = long;
  env[SHORT_FOLDER_VARIABLE] = short;
  env[RUN_MARKER] = run;
  return () => {
    for (const folder of [long, short]) {
      rmSync(folder, { recursive: true, force: true });
    }
    if (before === undefined) {
      delete env.TMPDIR;
    } else {
      env.TMPDIR = before;
    }
    Reflect.deleteProperty(env, SHORT_FOLDER_VARIABLE);
    Reflect.deleteProperty(env, RUN_MARKER);
  };
}

function removeStale(base: string, now: Date): void {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    const folder = join(base, name);
    try {
      if (now.getTime() - statSync(folder).mtimeMs > STALE_AFTER_MS) {
        rmSync(folder, { recursive: true, force: true });
      }
    } catch {
      // Another run removed it, or it cannot be: no matter to this run.
    }
  }
}
