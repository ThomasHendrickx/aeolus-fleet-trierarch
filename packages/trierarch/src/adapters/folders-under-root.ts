import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { TRASH_FOLDER_NAME } from './trash.js';

/**
 * The folders under each root a workspace could be (gap rule 2), whatever
 * made them: each `<root>/<repository>/<name>`, and each folder straight
 * under a root, a ship's folder among them. The roots are the place of
 * ships/ and the worktree root of the ships crewed before the ship folders. One with a `.git` of its own is one folder, none of
 * its files. A repository's own folder (`isRepository`, by its name) or one
 * holding the trash is the layout's and stays: only what it holds is listed.
 * Any other is listed with each folder in it, so the one a ship is crewed in
 * keeps it and what else it holds goes. Never the trash, a file, or a link,
 * so nothing a link points at is removed.
 */
export async function foldersUnderRoot(roots: readonly string[], isRepository: (name: string) => Promise<boolean>): Promise<readonly string[]> {
  const found: string[] = [];
  const tops = (await Promise.all(roots.map(foldersIn))).flat();
  for (const top of tops) {
    if (await hasGit(top)) {
      found.push(top);
      continue;
    }
    const isLayout = (await isRepository(basename(top))) || (await lstat(join(top, TRASH_FOLDER_NAME)).catch(() => undefined)) !== undefined;
    found.push(...(isLayout ? [] : [top]), ...(await foldersIn(top)));
  }
  return found;
}

/**
 * Whether the folder is one a workspace could be under a root: one or two
 * levels below it, never the root or the trash. A root reached through a link
 * counts by its real path too, as a container's workspace goes by its real one.
 */
export async function isUnderRoot(roots: readonly string[], folder: string): Promise<boolean> {
  const realRoots = await Promise.all(roots.map(async (root) => realpath(root).catch(() => root)));
  return [...roots, ...realRoots].some((each) => {
    const parts = relative(each, folder).split(sep);
    return parts.length <= 2 && parts.every((part) => part !== '' && part !== '..' && part !== TRASH_FOLDER_NAME);
  });
}

async function foldersIn(parent: string): Promise<readonly string[]> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && entry.name !== TRASH_FOLDER_NAME).map((entry) => join(parent, entry.name));
}

const hasGit = async (folder: string): Promise<boolean> => (await lstat(join(folder, '.git')).catch(() => undefined)) !== undefined;
