import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { trierarchNameSchema } from '@aeolus-fleet/common';

/** Where a place may be: a repository to make worktrees of, or a folder to crew a ship in as it is. */
export type PlaceKind = 'repository' | 'folder';

/** Why a name is no name of a place, or undefined when it is one. */
export function nameRefusal(name: string): string | undefined {
  return trierarchNameSchema.safeParse(name).success ? undefined : `${name} is no name: lowercase letters, digits and hyphens.`;
}

/** A path as the operator wrote it, absolute: `~` is the home directory, a relative path is from here. */
export function absolutePath(written: string, homeDirectory: string): string {
  const expanded = written.replace(/^~(?=$|\/)/, homeDirectory);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Why an absolute path is no such place, or undefined when it is one: a repository is a git checkout, a folder a folder. */
export async function placeRefusal(kind: PlaceKind, absolute: string): Promise<string | undefined> {
  if (kind === 'repository') {
    return (await stat(join(absolute, '.git')).catch(() => undefined)) === undefined ? `${absolute} is no git checkout.` : undefined;
  }
  return (await stat(absolute).catch(() => undefined))?.isDirectory() === true ? undefined : `${absolute} is no folder.`;
}
