import { chmod, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { LeftInTrash, TrashPort } from '../core/ports.js';
import { runCommand, type CommandResult } from './run-command.js';

/**
 * The trash a ship's clone and its ship's home go to when they are removed
 * (docs/trierarch.md, "Session runtime"). A session can leave in them what the
 * host user cannot remove: a folder owned by an id its user namespace maps, or
 * one it made read-only. Each is first renamed aside, into a trash folder of
 * the trierarch's own beside it, which needs only the parent the host owns:
 * its ship's place is free at once and nothing reads it again. Every pass then
 * empties the trash, and what stays in it holds back no release.
 */

/** The trash folder beside what goes in it. */
const FOLDER_NAME = '.trash';

/**
 * What the trash holds is named `<name>.<unix milliseconds it was discarded
 * at>`, with a suffix once it could not be removed: its state is in its name,
 * so it holds across a restart.
 */
const LEFT_SUFFIX = '.left';
const TOLD_SUFFIX = '.told';

/** A trash only its owner opens. */
const PRIVATE_FOLDER_MODE = 0o700;

/** The owner's read, write and search on a folder. */
const OWNER_RWX = 0o700;

/** Renames the folder into the trash beside it. */
export async function discard(folder: string, at: Date): Promise<void> {
  const trash = join(dirname(folder), FOLDER_NAME);
  await mkdir(trash, { mode: PRIVATE_FOLDER_MODE }).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  });
  if (!(await lstat(trash)).isDirectory()) {
    throw new Error(`The trash ${trash} is no folder`);
  }
  await rename(folder, join(trash, `${basename(folder)}.${String(at.getTime())}`));
}

/**
 * Gives each folder in it, its own included, its owner's read, write and
 * search, following no link: a folder a session made read-only would keep
 * what it holds from being removed.
 */
async function writableByItsOwner(folder: string): Promise<void> {
  const found = await lstat(folder).catch(() => undefined);
  if (found?.isDirectory() !== true) {
    return;
  }
  await chmod(folder, found.mode | OWNER_RWX);
  // An entry read from a folder is a link, not what it points at.
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await writableByItsOwner(join(folder, entry.name));
    }
  }
}

/** A name in the trash: what it was named, when it was discarded and its state suffix; undefined for a name the trash did not give. */
function parse(entry: string): { name: string; trashedAt: Date; state: '' | typeof LEFT_SUFFIX | typeof TOLD_SUFFIX } | undefined {
  const state = entry.endsWith(LEFT_SUFFIX) ? LEFT_SUFFIX : entry.endsWith(TOLD_SUFFIX) ? TOLD_SUFFIX : '';
  const named = entry.slice(0, entry.length - state.length);
  const at = named.lastIndexOf('.');
  const millis = named.slice(at + 1);
  if (at <= 0 || !/^-?\d+$/.test(millis)) {
    return undefined;
  }
  return { name: named.slice(0, at), trashedAt: new Date(Number(millis)), state };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Empties the trash beside each folder `beside` answers, read each pass: with
 * the host's own removal, then within the runtime's user namespace where the
 * ids a session mapped are its own (`unshare`, none on the host).
 */
export function createTrash(options: { beside: () => Promise<readonly string[]>; unshare?: (path: string) => Promise<void> }): TrashPort {
  const remove = async (path: string): Promise<string | undefined> => {
    try {
      await writableByItsOwner(path);
      await rm(path, { recursive: true, force: true });
      return undefined;
    } catch (error) {
      if (options.unshare === undefined) {
        return reasonOf(error);
      }
      try {
        await options.unshare(path);
        return undefined;
      } catch (unshared) {
        return `${reasonOf(error)}; ${reasonOf(unshared)}`;
      }
    }
  };

  return {
    empty: async () => {
      const left: LeftInTrash[] = [];
      for (const beside of await options.beside()) {
        const trash = join(beside, FOLDER_NAME);
        for (const entry of await readdir(trash).catch(() => [])) {
          const parsed = parse(entry);
          if (parsed === undefined) {
            continue;
          }
          const path = join(trash, entry);
          const why = await remove(path);
          if (why === undefined) {
            continue;
          }
          const found = { folder: join(beside, parsed.name), trashedAt: parsed.trashedAt, isTold: parsed.state === TOLD_SUFFIX };
          if (parsed.state !== '') {
            left.push({ ...found, path, isNew: false, why });
            continue;
          }
          // Marked left, so it is new only this once.
          try {
            await rename(path, `${path}${LEFT_SUFFIX}`);
            left.push({ ...found, path: `${path}${LEFT_SUFFIX}`, isNew: true, why });
          } catch (error) {
            left.push({ ...found, path, isNew: true, why: `${why}; ${reasonOf(error)}` });
          }
        }
      }
      return left;
    },
    markTold: async (path) => {
      if (path.endsWith(LEFT_SUFFIX)) {
        await rename(path, `${path.slice(0, path.length - LEFT_SUFFIX.length)}${TOLD_SUFFIX}`);
      }
    },
  };
}

/** The folders under each of the roots: where a clone or a ship's home is discarded from, beside which each trash is. */
export function foldersUnder(roots: readonly string[]): () => Promise<readonly string[]> {
  return async () => {
    const found: string[] = [];
    for (const root of roots) {
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) {
          found.push(join(root, entry.name));
        }
      }
    }
    return found;
  };
}

/**
 * Removes a path within the container runtime's user namespace, where the
 * host user is root and the ids a session mapped are its own: what a session
 * left that the host user cannot remove.
 */
export function removeWithinUserNamespace(binary: string, run: (command: string, options: { args: readonly string[] }) => Promise<CommandResult> = runCommand): (path: string) => Promise<void> {
  return async (path) => {
    const result = await run(binary, { args: ['unshare', 'rm', '-rf', '--', path] });
    if (result.status !== 0) {
      throw new Error(`${binary} unshare rm failed: ${result.stderr.trim()}`);
    }
  };
}
