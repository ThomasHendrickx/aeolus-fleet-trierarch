/**
 * The Go trierarch's file in the user's own folder, ~/.local/bin/aeolus-trierarch,
 * as today's trierarch puts a release's binary there (#142): staged beside it
 * first, so a binary that does not run never takes the place, and the file
 * that was there kept aside until the upgrade holds, so a failed one puts it
 * back.
 */
import { chmod, link, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const EXECUTABLE_MODE = 0o755;

/** The trierarch's file in ~/.local/bin, as upgrade puts a release's binary in its place. */
export interface BinaryFile {
  /** Where the binary goes. */
  readonly path: string;
  /** Writes the binary beside its place, executable: the staged file's path. */
  stage(binary: Buffer): Promise<string>;
  /** Puts the staged binary in place, the file there before kept aside. */
  place(): Promise<void>;
  /** Puts back what was in place before: the file kept aside, or none. */
  putBack(): Promise<void>;
  /** Removes the staged file and the one kept aside: only the file in place stays. */
  settle(): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function createBinaryFile(at: { path: string; version: string }): BinaryFile {
  const { path } = at;
  const folder = dirname(path);
  const staged = join(folder, `.${basename(path)}-${at.version}`);
  const kept = join(folder, `.${basename(path)}-before-${at.version}`);
  let isKept = false;
  return {
    path,
    stage: async (binary) => {
      await mkdir(folder, { recursive: true });
      await writeFile(staged, binary, { mode: EXECUTABLE_MODE });
      // writeFile's mode is cut by the umask: the binary must run.
      await chmod(staged, EXECUTABLE_MODE);
      return staged;
    },
    place: async () => {
      await rm(kept, { force: true });
      try {
        await link(path, kept);
        isKept = true;
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }
      await rename(staged, path);
    },
    putBack: async () => {
      if (isKept) {
        await rename(kept, path);
        isKept = false;
        return;
      }
      await rm(path, { force: true });
    },
    settle: async () => {
      await rm(staged, { force: true });
      await rm(kept, { force: true });
      isKept = false;
    },
  };
}
