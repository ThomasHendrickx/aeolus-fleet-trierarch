import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { type CommandResult, runCommand } from './run-command.js';

/**
 * Git in a ship's folder. The folder is its session's to write, `.git` and
 * its config included, and with sessions in containers a session runs apart
 * from the host (trierarch.md, "Session runtime"). So the host's git calls in a
 * ship's folder ignore the folder's own config where it names a program for
 * git to run: git runs no hook, in a folder or in the config, no fsmonitor, no filter, diff or merge driver,
 * and no command for a transport, pager, editor or credential the folder's
 * config names, and takes no optional lock, and fetches no object the folder lacks. No filter runs, the machine's own
 * included, as the folder's attributes may name it, but in a fresh clone the
 * trierarch just made, which no session touched yet. Otherwise the machine's own
 * config (global and system) applies as before. A folder whose config names a
 * program for git-lfs, which reads that config itself, is not read. Git is pointed at no folder but the ship's
 * own: a folder whose config sets core.worktree is not read, and a clone is
 * read only through its own `.git` folder, with its own objects alone: a clone whose config names a remote to fetch missing objects from is not read. A folder that is not read is
 * refused with why, so what it holds is not known, as is one where a git call
 * does not end within its time limit, as what git waits on may never come.
 */

/** A folder the host does not read, with why. */
export class RefusedRead extends Error {
  constructor(
    folder: string,
    readonly reason: string,
  ) {
    super(`Will not read ${folder}: ${reason}`);
  }
}

/** How long a host git call in a ship's folder runs before it is ended and the folder not read. */
const TIME_LIMIT_MS = 60_000;

/** How long a host git call in a fresh clone runs: its fetch and checkout may download what the machine's filters fetch, as git-lfs's. */
const FRESH_TIME_LIMIT_MS = 600_000;

/** How long each host git call in a ship's folder may run. */
export interface Limits {
  readonly timeLimitMs?: number;
}

/** Git, ended at its time limit: a call that did not end refuses the folder. */
async function gitWithin(folder: string, call: { args: readonly string[]; env: Readonly<Record<string, string>>; limits: Limits }): Promise<CommandResult> {
  const timeLimitMs = call.limits.timeLimitMs ?? TIME_LIMIT_MS;
  const result = await runCommand('git', { args: call.args, env: call.env, timeoutMs: timeLimitMs });
  if (result.isTimedOut === true) {
    const action = call.args[0] === '-C' ? call.args[2] : call.args[0];
    throw new RefusedRead(folder, `git ${action ?? ''} did not end within ${String(timeLimitMs / 1000)} seconds`);
  }
  return result;
}

interface Override {
  readonly name: string;
  readonly value: string;
}

/** The values the host's git calls take in a ship's folder whatever its config says: no hooks in a folder and no fsmonitor. */
const HARMLESS: readonly Override[] = [
  { name: 'core.fsmonitor', value: 'false' },
  { name: 'core.hooksPath', value: '/dev/null' },
];

/** The config variables that name a program git runs, by section, then by variable; a section of three-part names (`filter.<driver>.clean`) holds the variables of any subsection. */
const NAMES_A_PROGRAM: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
    core: ['sshcommand', 'pager', 'editor', 'askpass', 'gitproxy', 'alternaterefscommand'],
    sequence: ['editor'],
    diff: ['external', 'command', 'textconv'],
    merge: ['driver'],
    gpg: ['program'],
    credential: ['helper'],
    interactive: ['difffilter'],
    remote: ['uploadpack', 'receivepack'],
    mergetool: ['cmd'],
    difftool: ['cmd'],
  }),
);

/** The folder's own config: its `.git/config`, what it includes, and its worktree's config. */
const FOLDER_SCOPES: readonly string[] = ['local', 'worktree'];

/** Whether the variable, as git lists it (section and variable in lower case), names a program git runs. */
function isProgram(name: string): boolean {
  const section = name.slice(0, name.indexOf('.'));
  const variable = name.slice(name.lastIndexOf('.') + 1);
  return section === 'pager' || (NAMES_A_PROGRAM.get(section)?.includes(variable) ?? false);
}

/** The value that turns the variable off: no pager, else no program. */
function neutralOf(name: string): Override {
  return { name, value: name.startsWith('pager.') ? 'false' : '' };
}

/** The filter driver a variable of a filter (`filter.<driver>.clean`) belongs to, running nothing and not required; none for another variable. */
function filterOffOf(name: string): readonly Override[] {
  const first = name.indexOf('.');
  const last = name.lastIndexOf('.');
  if (name.slice(0, first) !== 'filter' || last === first) {
    return [];
  }
  const driver = name.slice(0, last);
  return [
    { name: `${driver}.process`, value: '' },
    { name: `${driver}.clean`, value: '' },
    { name: `${driver}.smudge`, value: '' },
    { name: `${driver}.required`, value: 'false' },
  ];
}

/** Fetches no object the folder lacks, from any remote its config names to fetch missing objects from. */
const NO_LAZY_FETCH: Readonly<Record<string, string>> = { GIT_NO_LAZY_FETCH: '1' };

/** Whether the variable, as git lists it, makes a remote one git fetches missing objects from: a partial clone's, or any promisor remote. */
function isPromisor(name: string): boolean {
  return name === 'extensions.partialclone' || (name.startsWith('remote.') && name.endsWith('.promisor'));
}

/** The sections of git-lfs's own config that name a program it runs, which git-lfs reads from the folder's config itself. */
const LFS_PROGRAMS: readonly string[] = ['lfs.extension.', 'lfs.customtransfer.'];

/** The hook a variable of a hook in the config (`hook.<name>.command`) belongs to, turned off and bound to no event; none for another variable. */
function hookOffOf(name: string): readonly Override[] {
  const first = name.indexOf('.');
  const last = name.lastIndexOf('.');
  if (name.slice(0, first) !== 'hook' || last === first) {
    return [];
  }
  const hook = name.slice(0, last);
  // An empty event resets the hook's events.
  return [
    { name: `${hook}.enabled`, value: 'false' },
    { name: `${hook}.event`, value: '' },
    { name: `${hook}.command`, value: '' },
  ];
}

/**
 * Where git finds the folder's repository, given in the environment when it
 * is; whether the folder is a clone, whose config names no remote to fetch
 * missing objects from; and whether it is a fresh clone, which no session
 * touched yet, so its checkout runs the filters the machine's own config
 * defines.
 */
interface Located {
  readonly env: Readonly<Record<string, string>>;
  readonly isClone: boolean;
  readonly isFresh: boolean;
  readonly limits: Limits;
}

/** The overrides of every variable of the folder's own config that names a program, after the harmless ones; a folder whose config points git at another work tree is not read, nor a clone whose config names a remote to fetch missing objects from. */
async function overridesIn(folder: string, located: Located): Promise<readonly Override[]> {
  const listed = await gitWithin(folder, { args: ['-C', folder, 'config', '--list', '--show-scope', '--name-only', '-z'], env: { ...located.env, ...NO_LAZY_FETCH }, limits: located.limits });
  if (listed.status !== 0) {
    throw new Error(`git config failed in ${folder}: ${listed.stderr.trim()}`);
  }
  const fields = listed.stdout.split('\0');
  const overrides = [...HARMLESS];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i] ?? '';
    const name = fields[i + 1] ?? '';
    // Of every scope but a fresh clone's: the folder's attributes may name a filter the machine's own config defines, as git-lfs's.
    if (!located.isFresh || FOLDER_SCOPES.includes(scope)) {
      overrides.push(...filterOffOf(name).filter((off) => !overrides.some((each) => each.name === off.name)));
    }
    if (!FOLDER_SCOPES.includes(scope)) {
      continue;
    }
    if (name === 'core.worktree') {
      throw new RefusedRead(folder, 'its config sets core.worktree, which points git at another folder');
    }
    if (LFS_PROGRAMS.some((section) => name.startsWith(section))) {
      throw new RefusedRead(folder, `its config names a program for git-lfs: ${name}`);
    }
    if (located.isClone && isPromisor(name)) {
      throw new RefusedRead(folder, `its config names a remote to fetch missing objects from: ${name}`);
    }
    if (isProgram(name)) {
      overrides.push(neutralOf(name));
    }
    overrides.push(...hookOffOf(name).filter((off) => !overrides.some((each) => each.name === off.name)));
  }
  return overrides;
}

/** Git in the folder, with where it finds its repository given in the environment when it is. */
async function gitIn(folder: string, at: { args: readonly string[]; located: Located }): Promise<CommandResult> {
  const overrides = await overridesIn(folder, at.located);
  // Given in the environment rather than as -c, so a name holding an equals sign is taken whole.
  const env: Record<string, string> = { ...at.located.env, ...NO_LAZY_FETCH, GIT_CONFIG_COUNT: String(overrides.length), GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const [i, { name, value }] of overrides.entries()) {
    env[`GIT_CONFIG_KEY_${i}`] = name;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  return gitWithin(folder, { args: ['-C', folder, ...at.args], env, limits: at.located.limits });
}

/** The folder's own git folder: its `.git` when that is a folder, else the one its `.git` file names; none without a `.git`. */
async function ownGitFolderOf(folder: string): Promise<string | undefined> {
  const dotGit = join(folder, '.git');
  const found = await lstat(dotGit).catch(() => undefined);
  if (found === undefined) {
    return undefined;
  }
  if (found.isDirectory()) {
    return dotGit;
  }
  if (!found.isFile()) {
    throw new RefusedRead(folder, 'its .git is neither a file nor a folder of its own');
  }
  const named = /^gitdir: (?<path>.+)$/m.exec(await readFile(dotGit, 'utf8'))?.groups?.path;
  return named === undefined ? undefined : resolve(folder, named.trim());
}

/**
 * Runs git in a ship's folder with the folder's own config naming no program,
 * and only a local repository to fetch from. A folder whose `.git` is neither
 * a file nor a folder, or whose own git folder (a worktree's, which its `.git`
 * file names) is no folder or holds a link or a special file, is not read.
 */
export async function gitInFolder(folder: string, args: readonly string[]): Promise<CommandResult> {
  const gitFolder = await ownGitFolderOf(folder);
  if (gitFolder !== undefined) {
    if ((await lstat(gitFolder).catch(() => undefined))?.isDirectory() !== true) {
      throw new RefusedRead(folder, 'its .git names no folder of its own');
    }
    const irregular = await irregularIn(gitFolder);
    if (irregular !== undefined) {
      throw new RefusedRead(folder, irregular);
    }
  }
  return gitIn(folder, { args, located: { env: {}, isClone: false, isFresh: false, limits: {} } });
}

/** What git said, on one line (a reason is one line) and without its hints, which are advice, not the cause. */
export function messageOf(stderr: string): string {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('hint:'))
    .join('; ');
}

/** Why the first entry in the git folder that is neither a regular file nor a folder is not read, by its path in it: a link would lead git out of it, and git reading a special file, such as a named pipe, may never end. */
async function irregularIn(gitFolder: string): Promise<string | undefined> {
  // Not followed: a recursive listing lists a link to a folder as a link.
  const found = (await readdir(gitFolder, { recursive: true, withFileTypes: true })).find((each) => !each.isFile() && !each.isDirectory());
  if (found === undefined) {
    return undefined;
  }
  const path = relative(gitFolder, join(found.parentPath, found.name));
  return found.isSymbolicLink() ? `its .git holds a link: ${path}` : `its .git holds a special file: ${path}`;
}

/** The variables of a config file that include another, as git lists them. */
const INCLUDES = '^include(if\\..*)?\\.path$';

/** Whether the path lies in the folder. */
function isIn(folder: string, path: string): boolean {
  const inFolder = relative(folder, path);
  return !isAbsolute(inFolder) && inFolder !== '..' && !inFolder.startsWith(`..${sep}`);
}

/**
 * The first file the git folder's config includes from outside it, as the
 * config names it, or that a file it includes includes in turn: git would read
 * it, and only what lies in the git folder is checked. A path from a home
 * folder or git's own prefix is outside.
 */
async function includeOutside(gitFolder: string, limits: Limits): Promise<string | undefined> {
  const toRead = [join(gitFolder, 'config'), join(gitFolder, 'config.worktree')];
  const read = new Set<string>();
  for (let file = toRead.shift(); file !== undefined; file = toRead.shift()) {
    if (read.has(file) || (await lstat(file).catch(() => undefined)) === undefined) {
      continue;
    }
    read.add(file);
    const listed = await gitWithin(dirname(gitFolder), { args: ['config', '--file', file, '--null', '--get-regexp', INCLUDES], env: NO_LAZY_FETCH, limits });
    // None found answers 1.
    if (listed.status === 1) {
      continue;
    }
    if (listed.status !== 0) {
      throw new Error(`git config failed: ${messageOf(listed.stderr)}`);
    }
    for (const entry of listed.stdout.split('\0').filter((each) => each !== '')) {
      const value = entry.slice(entry.indexOf('\n') + 1);
      const path = resolve(dirname(file), value);
      if (value.startsWith('~') || value.startsWith('%(') || !isIn(gitFolder, path)) {
        return value;
      }
      toRead.push(path);
    }
  }
  return undefined;
}

/**
 * Git in a ship's clone, within the limits, as in its folder: through the clone's own `.git`
 * folder and with the clone as its work tree, whatever the clone says: a
 * `.git` that is a file or a link, that names another folder's in its
 * commondir, that holds a link, that names another repository's objects in
 * its alternates, or whose config includes a file from outside it, would point
 * git at another folder, so such a clone is not read; nor one whose `.git`
 * holds a special file, such as a named pipe, which git may wait on forever.
 */
export function gitInCloneWithin(limits: Limits): (clone: string, args: readonly string[]) => Promise<CommandResult> {
  return (clone, args) => gitInCloneAt(clone, { args, limits, isFresh: false });
}

/** Git in a clone the trierarch just made from a trusted repository, before any session touched it, as in any clone, but through the filters the machine's own config defines, so its checkout is what a session works on (git-lfs's files, not their pointers). */
export function gitInFreshClone(clone: string, args: readonly string[]): Promise<CommandResult> {
  return gitInCloneAt(clone, { args, limits: { timeLimitMs: FRESH_TIME_LIMIT_MS }, isFresh: true });
}

async function gitInCloneAt(clone: string, at: { args: readonly string[]; limits: Limits; isFresh: boolean }): Promise<CommandResult> {
  const { args, limits, isFresh } = at;
  const gitFolder = join(clone, '.git');
  const found = await lstat(gitFolder).catch(() => undefined);
  if (found?.isDirectory() !== true) {
    throw new RefusedRead(clone, 'its .git is no folder of its own');
  }
  if ((await lstat(join(gitFolder, 'commondir')).catch(() => undefined)) !== undefined) {
    throw new RefusedRead(clone, 'its .git names another git folder in its commondir');
  }
  const irregular = await irregularIn(gitFolder);
  if (irregular !== undefined) {
    throw new RefusedRead(clone, irregular);
  }
  if ((await lstat(join(gitFolder, 'objects', 'info', 'alternates')).catch(() => undefined)) !== undefined) {
    throw new RefusedRead(clone, "its .git names another repository's objects in objects/info/alternates");
  }
  const include = await includeOutside(gitFolder, limits);
  if (include !== undefined) {
    throw new RefusedRead(clone, `its config includes a file outside its .git: ${include}`);
  }
  return gitIn(clone, { args, located: { env: { GIT_DIR: gitFolder, GIT_WORK_TREE: clone }, isClone: true, isFresh, limits } });
}
