import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { LeftInTrash, TrashPort } from '../core/ports.js';
import { runCommand, type CommandResult } from './run-command.js';

/**
 * The trash a ship's clone and its ship's home go to when they are removed
 * (docs/trierarch.md, "Session runtime"). A session can leave in them what the
 * host user cannot remove: a folder owned by an id its user namespace maps, or
 * one it made read-only. Each is first renamed aside, into a trash folder of
 * the trierarch's own beside it: its ship's place is free at once and nothing
 * reads it again. Every pass then empties the trash, and what stays in it
 * holds back no release.
 */

/** The trash folder beside what goes in it. */
export const TRASH_FOLDER_NAME = '.trash';

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

/** Moves a folder to a path within the runtime's user namespace, where the ids a session mapped are its own. */
export type MoveWithinUserNamespace = (from: string, to: string) => Promise<void>;

/**
 * Renames the folder into the trash beside it. Moving a folder to another
 * parent changes its `..`, which needs write on the folder itself as well as
 * on both parents, and a session can have made its own top read-only: it is
 * given its owner's read, write and search first. One the host cannot give
 * them, or move, is moved within the runtime's user namespace
 * (`withinUserNamespace`, none on the host). A link is refused, so nothing it
 * points at is changed.
 */
export async function discard(folder: string, options: { at: Date; withinUserNamespace?: MoveWithinUserNamespace }): Promise<void> {
  const { at, withinUserNamespace } = options;
  const found = await lstat(folder);
  if (!found.isDirectory()) {
    throw new Error(`${folder} is no folder: the trash takes only a folder`);
  }
  const trash = join(dirname(folder), TRASH_FOLDER_NAME);
  await mkdir(trash, { mode: PRIVATE_FOLDER_MODE }).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  });
  if (!(await lstat(trash)).isDirectory()) {
    throw new Error(`The trash ${trash} is no folder`);
  }
  const to = join(trash, `${basename(folder)}.${String(at.getTime())}`);
  try {
    await chmod(folder, found.mode | OWNER_RWX);
    await rename(folder, to);
  } catch (error) {
    if (withinUserNamespace === undefined) {
      throw error;
    }
    try {
      await withinUserNamespace(folder, to);
    } catch (moved) {
      throw new Error(`${reasonOf(error)}; ${reasonOf(moved)}`, { cause: moved });
    }
  }
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
        const trash = join(beside, TRASH_FOLDER_NAME);
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
          // Where it was put in the trash, before any state suffix: the same every pass and across a restart.
          const pathHash = createHash('sha256').update(path.slice(0, path.length - parsed.state.length)).digest('hex');
          const found = { folder: join(beside, parsed.name), pathHash, trashedAt: parsed.trashedAt, isTold: parsed.state === TOLD_SUFFIX };
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

/** How long a call within the runtime's user namespace may run: a runtime that hangs holds up no pass. A removal it ends is taken up again by the next pass. */
const UNSHARE_TIME_LIMIT_MS = 60_000;

type Run = (command: string, options: { args: readonly string[]; timeoutMs?: number }) => Promise<CommandResult>;

/** Runs the words within the runtime's user namespace, ended at its time limit. */
async function withinUserNamespace(runtime: { binary: string; run: Run }, args: readonly string[]): Promise<void> {
  const { binary, run } = runtime;
  const result = await run(binary, { args: ['unshare', ...args], timeoutMs: UNSHARE_TIME_LIMIT_MS });
  if (result.isTimedOut === true) {
    throw new Error(`${binary} unshare ${args[0] ?? ''} did not end within ${String(UNSHARE_TIME_LIMIT_MS)} ms`);
  }
  if (result.status !== 0) {
    throw new Error(`${binary} unshare ${args[0] ?? ''} failed: ${result.stderr.trim()}`);
  }
}

/**
 * Removes a path within the container runtime's user namespace, where the
 * host user is root and the ids a session mapped are its own: what a session
 * left that the host user cannot remove.
 */
export function removeWithinUserNamespace(binary: string, run: Run = runCommand): (path: string) => Promise<void> {
  return (path) => withinUserNamespace({ binary, run }, ['rm', '-rf', '--', path]);
}

/**
 * Gives a folder its owner's read, write and search and moves it to the path,
 * within the container runtime's user namespace: a folder whose own top the
 * host user cannot give its write, as one owned by an id a session mapped.
 */
export function moveWithinUserNamespace(binary: string, run: Run = runCommand): MoveWithinUserNamespace {
  return async (from, to) => {
    await withinUserNamespace({ binary, run }, ['chmod', 'u+rwx', '--', from]);
    await withinUserNamespace({ binary, run }, ['mv', '-T', '--', from, to]);
  };
}
