import { lstat, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { TrierarchWorkspace } from '@aeolus-fleet/common';

import { discard, type MoveWithinUserNamespace } from './trash.js';

/**
 * The ship folder (docs/design/ship-folder.md): `<ships>/<shipId>/repositories`,
 * where a ship's session starts, holding its main repository in `main/` and
 * each sub-repository in `sub-repos/<repository>/`, side by side, so no
 * repository sits inside another. The folder itself is no repository: what a
 * session leaves at its root is never committed. Its root AGENTS.md, with
 * CLAUDE.md a link to it so every harness reads the same, is the
 * trierarch's, written again at every start. A new settings version keeps
 * each repository it still names as it is, makes each it newly names, and
 * moves each it no longer names into the trash beside the ships' folders; a
 * main naming another repository replaces `main/`. Each repository is made
 * as its workspace makes one: a worktree on the host, a clone in a container.
 */

/** The ship folder in a ship's folder. */
export const SHIP_FOLDER = 'repositories';
/** The main repository in the ship folder. */
export const MAIN_FOLDER = 'main';
/** The folder of the sub-repositories in the ship folder, one folder each by its name. */
export const SUB_REPOSITORIES_FOLDER = 'sub-repos';

const ROOT_INSTRUCTIONS = 'AGENTS.md';
const ROOT_LINK = 'CLAUDE.md';

/** A ship's folder's mode: only its owner opens it. */
const SHIP_FOLDER_MODE = 0o700;

export type RepositoriesWorkspace = Extract<TrierarchWorkspace, { kind: 'repositories' }>;

/** A repository a ship folder names: its name in the configuration and the ref it starts at. */
export type NamedRepository = RepositoriesWorkspace['main'];

/** Makes a repository's workspace at the folder, when it is not there; one a stop mid-crew left is used as it is. */
export type MakeRepository = (repository: NamedRepository, folder: string) => Promise<void>;

/** The root AGENTS.md of a ship folder: where to work from, each sub-repository, and the layout's facts every ship shares. */
export function rootInstructionsOf(workspace: RepositoriesWorkspace): string {
  const named =
    workspace.subRepositories.length === 0
      ? ['None: this ship works in its main repository alone.']
      : workspace.subRepositories.map(({ repository }) => `- \`${SUB_REPOSITORIES_FOLDER}/${repository}/\`: read its AGENTS.md, or its CLAUDE.md where it has none, before working in it.`);
  return [
    '# This ship folder',
    '',
    `This folder holds the repositories this ship works in. Work from \`${MAIN_FOLDER}/\`, the main repository: read \`${MAIN_FOLDER}/AGENTS.md\` first, or \`${MAIN_FOLDER}/CLAUDE.md\` where it has none, and follow it.`,
    '',
    '## Sub-repositories',
    '',
    ...named,
    '',
    '## The layout',
    '',
    '- Each repository commits, branches and pushes on its own: run git inside the one you work in.',
    '- This folder holds no repository of its own: nothing outside a repository is committed, so keep your work in one.',
    "- The files and links at this folder's root, this AGENTS.md and CLAUDE.md a link to it, are the trierarch's, written again at every start: change nothing here.",
    '',
  ].join('\n');
}

/** Writes the ship folder's root AGENTS.md and CLAUDE.md, a link to it, again, whatever the session left there. */
export async function writeRootFiles(folder: string, workspace: RepositoriesWorkspace): Promise<void> {
  const link = join(folder, ROOT_LINK);
  await rm(join(folder, ROOT_INSTRUCTIONS), { recursive: true, force: true });
  await writeFile(join(folder, ROOT_INSTRUCTIONS), rootInstructionsOf(workspace));
  await rm(link, { recursive: true, force: true });
  await symlink(ROOT_INSTRUCTIONS, link);
}

/**
 * Makes the ship folder in the ship's folder, or brings the one it has to the
 * workspace: `main/` replaced when it was made of another repository, each
 * sub-repository no longer named into the trash, then the main repository and
 * each sub-repository made where it is not there yet, in the request's order.
 * One git cannot make fails it with git's message, and those made stay for
 * the next try: `onMainMade` is told once `main/` is made, before any
 * sub-repository. Answers the ship folder.
 */
export async function prepareShipFolder(at: {
  shipFolder: string;
  workspace: RepositoriesWorkspace;
  /** The repository `main/` was made of, when the entry knows it. */
  madeMain?: string;
  onMainMade?: (repository: string) => Promise<void>;
  make: MakeRepository;
  withinUserNamespace?: MoveWithinUserNamespace;
}): Promise<string> {
  const { shipFolder, workspace, make } = at;
  const folder = join(shipFolder, SHIP_FOLDER);
  await mkdir(dirname(shipFolder), { recursive: true });
  await mkdir(shipFolder, { recursive: true, mode: SHIP_FOLDER_MODE });
  await mkdir(join(folder, SUB_REPOSITORIES_FOLDER), { recursive: true });
  const toTrash = async (path: string): Promise<void> => {
    if ((await lstat(path).catch(() => undefined)) !== undefined) {
      await discard(path, { at: new Date(), into: dirname(shipFolder), ...(at.withinUserNamespace !== undefined && { withinUserNamespace: at.withinUserNamespace }) });
    }
  };
  if (at.madeMain !== undefined && at.madeMain !== workspace.main.repository) {
    await toTrash(join(folder, MAIN_FOLDER));
  }
  const named = new Set(workspace.subRepositories.map(({ repository }) => repository));
  for (const name of await readdir(join(folder, SUB_REPOSITORIES_FOLDER))) {
    if (!named.has(name)) {
      await toTrash(join(folder, SUB_REPOSITORIES_FOLDER, name));
    }
  }
  await make(workspace.main, join(folder, MAIN_FOLDER));
  await at.onMainMade?.(workspace.main.repository);
  for (const subRepository of workspace.subRepositories) {
    await make(subRepository, join(folder, SUB_REPOSITORIES_FOLDER, subRepository.repository));
  }
  return folder;
}

/** The folders of the repositories the ship folder holds now: `main/`, then each sub-repository by its name. */
export async function repositoryFoldersIn(folder: string): Promise<readonly string[]> {
  const main = join(folder, MAIN_FOLDER);
  const subRepositories = await readdir(join(folder, SUB_REPOSITORIES_FOLDER), { withFileTypes: true }).catch(() => []);
  return [
    ...((await lstat(main).catch(() => undefined))?.isDirectory() === true ? [main] : []),
    ...subRepositories
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(folder, SUB_REPOSITORIES_FOLDER, entry.name))
      .sort(),
  ];
}
