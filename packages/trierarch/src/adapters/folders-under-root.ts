import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { TRASH_FOLDER_NAME } from './trash.js';

/**
 * The folders under the worktree root a workspace could be (gap rule 2),
 * whatever made them: each `<root>/<repository>/<name>`, and a folder straight
 * under the root that has a `.git` of its own, as one folder, none of its
 * files. Never the trash, a file, or a link, so nothing a link points at is
 * removed.
 */
export async function foldersUnderRoot(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const top of await foldersIn(root)) {
    if (await hasGit(top)) {
      found.push(top);
      continue;
    }
    found.push(...(await foldersIn(top)));
  }
  return found;
}

/**
 * Whether the folder is one a workspace could be under the root: one or two
 * levels below it, never the root or the trash. A root reached through a link
 * counts by its real path too, as a container's workspace goes by its real one.
 */
export async function isUnderRoot(root: string, folder: string): Promise<boolean> {
  const realRoot = await realpath(root).catch(() => root);
  return [root, realRoot].some((each) => {
    const parts = relative(each, folder).split(sep);
    return parts.length <= 2 && parts.every((part) => part !== '' && part !== '..' && part !== TRASH_FOLDER_NAME);
  });
}

async function foldersIn(parent: string): Promise<readonly string[]> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && entry.name !== TRASH_FOLDER_NAME).map((entry) => join(parent, entry.name));
}

const hasGit = async (folder: string): Promise<boolean> => (await lstat(join(folder, '.git')).catch(() => undefined)) !== undefined;
