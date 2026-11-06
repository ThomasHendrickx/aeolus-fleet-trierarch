import { type CommandResult, runCommand } from './run-command.js';

/**
 * Git in a ship's folder. The folder is its session's to write, `.git` and
 * its config included, and with sessions in containers a session runs apart
 * from the host (trierarch.md, "Session runtime"). So the host's git calls in a
 * ship's folder ignore the folder's own config where it names a program for
 * git to run: git runs no hook, no fsmonitor, no filter, diff or merge driver,
 * and no command for a transport, pager, editor or credential the folder's
 * config names, and takes no optional lock. The machine's own config (global
 * and system) applies as before.
 */

interface Override {
  readonly name: string;
  readonly value: string;
}

/** The values the host's git calls take in a ship's folder whatever its config says: no hooks and no fsmonitor. */
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

/** The overrides of every variable of the folder's own config that names a program, after the harmless ones. */
async function overridesIn(folder: string): Promise<readonly Override[]> {
  const listed = await runCommand('git', { args: ['-C', folder, 'config', '--list', '--show-scope', '--name-only', '-z'] });
  if (listed.status !== 0) {
    throw new Error(`git config failed in ${folder}: ${listed.stderr.trim()}`);
  }
  const fields = listed.stdout.split('\0');
  const overrides = [...HARMLESS];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i] ?? '';
    const name = fields[i + 1] ?? '';
    if (FOLDER_SCOPES.includes(scope) && isProgram(name)) {
      overrides.push(neutralOf(name));
    }
  }
  return overrides;
}

/** Runs git in a ship's folder with the folder's own config naming no program, and only a local repository to fetch from. */
export async function gitInFolder(folder: string, args: readonly string[]): Promise<CommandResult> {
  const overrides = await overridesIn(folder);
  // Given in the environment rather than as -c, so a name holding an equals sign is taken whole.
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(overrides.length), GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const [i, { name, value }] of overrides.entries()) {
    env[`GIT_CONFIG_KEY_${i}`] = name;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  return runCommand('git', { args: ['-C', folder, ...args], env });
}
