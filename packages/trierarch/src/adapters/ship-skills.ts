import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rm, rmdir, stat, symlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

/**
 * The skills at the root of a ship folder (docs/design/ship-folder.md, point
 * 8): the root's `.claude/skills/<skill>` and `.agents/skills/<skill>` each
 * link to the skill of that name in `main/` and every sub-repository, so both
 * harnesses load them all at start. A name two repositories share with the
 * same content is one link, the first repository's; with different content
 * neither is linked, and the clash is answered for the root AGENTS.md to say.
 */

/** The folder each harness reads skills from, in a repository and at the root. */
export const SKILL_FOLDERS = ['.claude/skills', '.agents/skills'] as const;

/** A skill name that repositories hold with different content, in one harness's folder: where each is, from the ship folder. */
export interface SkillClash {
  skill: string;
  paths: readonly string[];
}

/** A repository of the ship folder: its folder from the ship folder, such as `main` or `sub-repos/tools`. */
type RepositoryFolder = string;

/**
 * Makes the root's skill folders again from the repositories as they are now,
 * whatever the session left there: none for a harness whose folder no
 * repository has a skill in. Answers each clash, in the order of the folders
 * and of the repositories.
 */
export async function linkSkills(folder: string, repositories: readonly RepositoryFolder[]): Promise<readonly SkillClash[]> {
  const clashes: SkillClash[] = [];
  for (const skillFolder of SKILL_FOLDERS) {
    const root = join(folder, skillFolder);
    await rm(root, { recursive: true, force: true });
    // The harness's folder goes too when that leaves it empty, and stays when the session keeps its own files in it.
    await rmdir(dirname(root)).catch(() => undefined);
    const held = new Map<string, { path: string; digest: string }[]>();
    for (const repository of repositories) {
      for (const skill of await skillsIn(join(folder, repository, skillFolder))) {
        const path = `${repository}/${skillFolder}/${skill.name}`;
        held.set(skill.name, [...(held.get(skill.name) ?? []), { path, digest: skill.digest }]);
      }
    }
    for (const [skill, each] of held) {
      const [first] = each;
      if (first === undefined) {
        continue;
      }
      if (each.every(({ digest }) => digest === first.digest)) {
        await mkdir(root, { recursive: true });
        await symlink(relative(root, join(folder, first.path)), join(root, skill));
      } else {
        clashes.push({ skill, paths: each.map(({ path }) => path) });
      }
    }
  }
  return clashes;
}

/** The skills a repository holds in a skill folder: each a folder, or a link to one, with a digest of everything in it. */
async function skillsIn(skillFolder: string): Promise<{ name: string; digest: string }[]> {
  const found: { name: string; digest: string }[] = [];
  for (const entry of (await readdir(skillFolder).catch(() => [])).sort()) {
    const path = join(skillFolder, entry);
    if ((await stat(path).catch(() => undefined))?.isDirectory() === true) {
      found.push({ name: entry, digest: (await digestOf(path, new Set())).digest('hex') });
    }
  }
  return found;
}

/** A digest of every file under a folder, by its path in it and its content, following links; a folder reached twice on the way down is left out. */
async function digestOf(folder: string, above: ReadonlySet<string>): Promise<ReturnType<typeof createHash>> {
  const digest = createHash('sha256');
  const here = await realpath(folder);
  if (above.has(here)) {
    return digest;
  }
  for (const entry of (await readdir(folder)).sort()) {
    const path = join(folder, entry);
    const found = await stat(path).catch(() => undefined);
    if (found?.isDirectory() === true) {
      digest.update(`dir ${entry}\0${(await digestOf(path, new Set([...above, here]))).digest('hex')}\0`);
    } else if (found?.isFile() === true) {
      digest.update(`file ${entry}\0`).update(await readFile(path)).update('\0');
    }
  }
  return digest;
}
