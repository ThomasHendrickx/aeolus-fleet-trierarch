import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { type CommandResult, runCommand } from './run-command.js';

/**
 * Git in a ship's folder. The folder is its session's to write, `.git` and
 * its config included, and with sessions in containers a session runs apart
 * from the host (trierarch.md, "Session runtime"). So the host's git calls in a
 * ship's folder ignore the folder's own config where it names a program for
 * git to run: git runs no hook, in a folder or in the config, no fsmonitor, no filter, diff or merge driver,
 * and no command for a transport, pager, editor or credential the folder's
 * config names, and takes no optional lock. The machine's own config (global
 * and system) applies as before. Git is pointed at no folder but the ship's
 * own: a folder whose config sets core.worktree is not read, and a clone is
 * read only through its own `.git` folder.
 */

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
    filter: ['clean', 'smudge', 'process', 'required'],
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

/** The value that turns the variable off: a filter that is not required, no pager, else no program. */
function neutralOf(name: string): Override {
  const isOff = name.startsWith('pager.') || (name.startsWith('filter.') && name.endsWith('.required'));
  return { name, value: isOff ? 'false' : '' };
}

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

/** The overrides of every variable of the folder's own config that names a program, after the harmless ones; a folder whose config points git at another work tree is not read. */
async function overridesIn(folder: string, located: Readonly<Record<string, string>>): Promise<readonly Override[]> {
  const listed = await runCommand('git', { args: ['-C', folder, 'config', '--list', '--show-scope', '--name-only', '-z'], env: located });
  if (listed.status !== 0) {
    throw new Error(`git config failed in ${folder}: ${listed.stderr.trim()}`);
  }
  const fields = listed.stdout.split('\0');
  const overrides = [...HARMLESS];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i] ?? '';
    const name = fields[i + 1] ?? '';
    if (!FOLDER_SCOPES.includes(scope)) {
      continue;
    }
    if (name === 'core.worktree') {
      throw new Error(`Will not read ${folder}: its config sets core.worktree, which points git at another folder`);
    }
    if (isProgram(name)) {
      overrides.push(neutralOf(name));
    }
    overrides.push(...hookOffOf(name).filter((off) => !overrides.some((each) => each.name === off.name)));
  }
  return overrides;
}

/** Git in the folder, with where it finds its repository given in the environment when it is. */
async function gitIn(folder: string, at: { args: readonly string[]; located: Readonly<Record<string, string>> }): Promise<CommandResult> {
  const overrides = await overridesIn(folder, at.located);
  // Given in the environment rather than as -c, so a name holding an equals sign is taken whole.
  const env: Record<string, string> = { ...at.located, GIT_CONFIG_COUNT: String(overrides.length), GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const [i, { name, value }] of overrides.entries()) {
    env[`GIT_CONFIG_KEY_${i}`] = name;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  return runCommand('git', { args: ['-C', folder, ...at.args], env });
}

/** Runs git in a ship's folder with the folder's own config naming no program, and only a local repository to fetch from. */
export async function gitInFolder(folder: string, args: readonly string[]): Promise<CommandResult> {
  return gitIn(folder, { args, located: {} });
}

/**
 * Runs git in a ship's clone as in its folder, through the clone's own `.git`
 * folder and with the clone as its work tree, whatever the clone says: a
 * `.git` that is a file or a link, or that names another folder's in its
 * commondir, would point git at another folder, so such a clone is not read.
 */
export async function gitInClone(clone: string, args: readonly string[]): Promise<CommandResult> {
  const gitFolder = join(clone, '.git');
  const found = await lstat(gitFolder).catch(() => undefined);
  if (found?.isDirectory() !== true) {
    throw new Error(`Will not read ${clone}: its .git is no folder of its own`);
  }
  if ((await lstat(join(gitFolder, 'commondir')).catch(() => undefined)) !== undefined) {
    throw new Error(`Will not read ${clone}: its .git names another git folder in its commondir`);
  }
  return gitIn(clone, { args, located: { GIT_DIR: gitFolder, GIT_WORK_TREE: clone } });
}
