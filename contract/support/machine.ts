import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTodaysTrierarch, TRIERARCH_UNDER_TEST } from './trierarch-under-test.js';

/**
 * A machine for the trierarch under test, as a program sees one: a home of
 * its own, a PATH whose harnesses are the stand-ins of
 * packages/trierarch/test/support behind the commands a real harness answers
 * (`claude`, `codex`, `copilot`), and a systemd user manager stand-in
 * (`systemctl`) that runs the service's program line as systemd would. The
 * environment holds nothing of the shell that runs the suite, so a crewed
 * session's variables never reach the trierarch.
 *
 * What the stand-ins were asked is kept in `machine` for the test to read:
 * each harness command line (`<harness>-calls.txt`), the service's log
 * (`systemd/trierarch.log`). A file there changes their answers:
 * `claude-signed-out` makes `claude auth status` fail, `claude-plugin-fails`
 * makes every `claude plugin` command fail.
 */
export interface Machine {
  readonly home: string;
  /** The stand-ins' own files, apart from the home. */
  readonly machine: string;
  /** The trierarch's files, as docs/architecture.md names them. */
  readonly trierarchHome: string;
  /** A git repository with one commit, to make worktrees of. */
  readonly repository: string;
  /** The aeolus-fleet plugin's data folder for Claude Code. */
  readonly pluginData: string;
  /** The trierarch under test as this machine runs it: a copy of its file in the home's ~/.local/bin, as an install puts it, so an upgrade replaces this machine's alone; one run by an interpreter, as today's, as it is. */
  readonly underTest: readonly string[];
  /** Runs the trierarch under test with the words given, from the home, to its end; another trierarch's command when `as` names one, with more variables when `env` gives them. */
  trierarch(words: readonly string[], at?: { input?: string; as?: readonly string[]; env?: Readonly<Record<string, string>> }): Promise<CommandOutcome>;
  /** Makes the stand-in answer otherwise, as the file of that name says. */
  toggle(name: StandInSwitch, isOn: boolean): void;
  /** The pid of the trierarch the service runs now, none when it is stopped. */
  servicePid(): number | undefined;
  /** What the service's trierarch wrote, for a failing test to show. */
  serviceLog(): string;
  /** Each command line a harness's stand-in was given outside a session, in order. */
  callsOf(harness: 'claude' | 'codex' | 'copilot'): string[];
  /** Stops every session and the service, then removes the machine. */
  remove(): Promise<void>;
}

export type StandInSwitch = 'claude-signed-out' | 'claude-plugin-fails';

export interface CommandOutcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const PLUGIN_ROOT = join(REPOSITORY_ROOT, 'plugins', 'aeolus-fleet');
const STAND_INS = join(REPOSITORY_ROOT, 'packages', 'trierarch', 'test', 'support');
const CONTRACT_SUPPORT = join(REPOSITORY_ROOT, 'contract', 'support');
/** The Copilot CLI version the stand-in says: one the trierarch proves its plugin's hooks on. */
const COPILOT_VERSION = '1.0.105';
const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
/** The Claude Code version the stand-in says, as the captures of fake-claude-code.ts. */
export const CLAUDE_CODE_VERSION = '2.1.306';
/** How long the stand-in systemd waits for a stopped trierarch to end. */
const STOP_WAIT_SECONDS = 10;

/** Runs a program to its end, never blocking this process: the fleet in it must answer meanwhile. */
export function runProgram(command: readonly string[], at: { cwd: string; env: Readonly<Record<string, string>>; input?: string }): Promise<CommandOutcome> {
  const [program = '', ...args] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: at.cwd, env: at.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
    // A program that ends without reading its input fails the write (EPIPE): its outcome says what happened.
    child.stdin.on('error', () => undefined);
    child.stdin.end(at.input ?? '');
  });
}

/** Where the machine's own programs are: git, ss, bash, curl and the rest the trierarch and the plugin's scripts run. */
const SYSTEM_FOLDERS = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
/** The harnesses and service managers a real install of this machine may hold: only the stand-ins answer to them. */
const STOOD_IN = new Set(['claude', 'codex', 'copilot', 'systemctl', 'systemd-run', 'launchctl', 'npm', 'npx']);

/** Links each of the machine's programs into `tools`, but for the ones stood in for, so a real Claude Code or Codex on this machine is never found. */
function linkSystemPrograms(tools: string): void {
  mkdirSync(tools);
  const linked = new Set<string>();
  for (const folder of SYSTEM_FOLDERS) {
    for (const name of existsSync(folder) ? readdirSync(folder) : []) {
      if (!STOOD_IN.has(name) && !linked.has(name)) {
        linked.add(name);
        symlinkSync(join(folder, name), join(tools, name));
      }
    }
  }
}

function script(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** `claude`: the commands init, detection and upgrade run answered as Claude Code answers them, and a session run by fake-claude-code.ts with the plugin's hooks. */
function claudeStandIn(at: { machine: string; pluginData: string }): string {
  return `#!/bin/sh
machine='${at.machine}'
case "$1" in
  --version) echo '${CLAUDE_CODE_VERSION} (Claude Code)'; exit 0 ;;
  --help)
    echo "$*" >> "$machine/claude-calls.txt"
    printf '%s\\n' 'Usage: claude [options] [command] [prompt]' \\
      "  --model <model>                 Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus')" \\
      '  --effort <level>                Effort level for the current session (low, medium, high)' \\
      '  --permission-mode <mode>        Permission mode to use for the session (choices: "acceptEdits", "bypassPermissions", "default", "plan")'
    exit 0 ;;
  auth)
    echo "$*" >> "$machine/claude-calls.txt"
    if [ -e "$machine/claude-signed-out" ]; then echo 'Not logged in' >&2; exit 1; fi
    echo '{"loggedIn":true}'; exit 0 ;;
  plugin)
    echo "$*" >> "$machine/claude-calls.txt"
    if [ -e "$machine/claude-plugin-fails" ]; then echo 'Failed to reach the marketplace' >&2; exit 1; fi
    if [ "$2" = list ]; then echo '[{"id":"aeolus-fleet@aeolus-fleet"}]'; fi
    exit 0 ;;
esac
if [ "$1" = -p ] && [ "$2" = --model ]; then
  echo "$*" >> "$machine/claude-calls.txt"
  echo "{\\"modelUsage\\":{\\"claude-$3-5\\":{}}}"; exit 0
fi
exec '${process.execPath}' '${join(STAND_INS, 'fake-claude-code.ts')}' --plugin '${PLUGIN_ROOT}' '${at.pluginData}' "$@"
`;
}

/**
 * `systemctl --user` for the trierarch's unit, as systemd runs it: restart
 * and start run the unit's ExecStart with its Environment, detached, in a
 * clean environment with the user's HOME; stop ends that process alone
 * (KillMode=process); show answers its state and MainPID.
 */
function systemctlStandIn(at: { machine: string; home: string }): string {
  const state = join(at.machine, 'systemd');
  return `#!/bin/bash
state='${state}'
mkdir -p "$state"
echo "$*" >> "$state/calls.txt"
[ "$1" = --user ] && shift
command="$1"; shift
unit="\${1:-aeolus-trierarch.service}"
file='${join(at.home, '.config', 'systemd', 'user')}'/"$unit"
pid() { [ -f "$state/pid" ] && kill -0 "$(cat "$state/pid")" 2>/dev/null && cat "$state/pid"; }
stop() {
  local running; running="$(pid)" || return 0
  kill -TERM "$running"
  for _ in $(seq ${String(STOP_WAIT_SECONDS * 10)}); do kill -0 "$running" 2>/dev/null || break; sleep 0.1; done
  rm -f "$state/pid"
}
start() {
  [ -f "$file" ] || { echo "Unit $unit not found." >&2; exit 5; }
  local line words=() environment=(HOME='${at.home}' USER="$USER" LANG=C.UTF-8)
  while IFS= read -r line; do
    case "$line" in
      ExecStart=*) eval "words=(\${line#ExecStart=})" ;;
      Environment=*) eval "environment+=(\${line#Environment=})" ;;
    esac
  done < "$file"
  cd '${at.home}' || exit 1
  env -i "\${environment[@]}" setsid "\${words[@]}" < /dev/null >> "$state/trierarch.log" 2>&1 &
  echo $! > "$state/pid"
}
case "$command" in
  daemon-reload|enable) ;;
  start) pid > /dev/null || start ;;
  restart) stop; start ;;
  stop) stop ;;
  disable) [ "$1" = --now ] && stop ;;
  show)
    if running="$(pid)"; then echo ActiveState=active; echo "MainPID=$running"; else echo ActiveState=inactive; echo MainPID=0; fi ;;
  *) echo "systemctl stand-in: no $command" >&2; exit 1 ;;
esac
`;
}

/** `codex`: the commands init, detection and setup run answered as Codex answers them; `codex exec` runs fake-codex.ts in the folder. */
function codexStandIn(at: { machine: string; pluginData: string }): string {
  return `#!/bin/sh
machine='${at.machine}'
case "$1" in
  --version) echo 'codex-cli 0.163.0'; exit 0 ;;
  login) echo "$*" >> "$machine/codex-calls.txt"; echo 'Logged in using ChatGPT'; exit 0 ;;
  debug) echo "$*" >> "$machine/codex-calls.txt"; echo '{"models":[{"slug":"gpt-5.6-terra","visibility":"list"}]}'; exit 0 ;;
  app-server) exec '${process.execPath}' '${join(CONTRACT_SUPPORT, 'fake-codex-app-server.ts')}' ;;
  plugin) echo "$*" >> "$machine/codex-calls.txt"; exit 0 ;;
esac
exec '${process.execPath}' '${join(STAND_INS, 'fake-codex.ts')}' "$@" --plugin '${PLUGIN_ROOT}' '${at.pluginData}'
`;
}

/** `copilot`: a proven version, its models as its help on config lists them, and a session run by fake-copilot.ts. */
function copilotStandIn(at: { machine: string; pluginData: string }): string {
  return `#!/bin/sh
machine='${at.machine}'
case "$1" in
  --version) echo 'GitHub Copilot CLI ${COPILOT_VERSION}.'; exit 0 ;;
  help)
    echo "$*" >> "$machine/copilot-calls.txt"
    printf '%s\\n' 'Configuration settings:' '' '  \`model\`: AI model to use for Copilot CLI.' '    - "claude-sonnet-4.5"' '    - "gpt-5"' ''
    exit 0 ;;
esac
exec '${process.execPath}' '${join(STAND_INS, 'fake-copilot.ts')}' "$@" --plugin '${PLUGIN_ROOT}' '${at.pluginData}'
`;
}

async function git(args: readonly string[]): Promise<void> {
  const ran = await runProgram(['git', ...args], { cwd: tmpdir(), env: { ...GIT_ENV, PATH: '/usr/bin:/bin', HOME: tmpdir() } });
  if (ran.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${ran.stderr}`);
  }
}

/** The harnesses a machine may have installed, besides Claude Code, which every machine has. */
export type OtherHarness = 'codex' | 'copilot';

/** A machine with Claude Code installed and signed in, and the other harnesses given, a repository checked out, and no trierarch yet. */
export async function aMachine(at: { others?: readonly OtherHarness[] } = {}): Promise<Machine> {
  const others = at.others ?? [];
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-contract-')));
  const home = join(root, 'home');
  const machine = join(root, 'machine');
  const bin = join(machine, 'bin');
  mkdirSync(home);
  mkdirSync(bin, { recursive: true });
  const tools = join(machine, 'tools');
  linkSystemPrograms(tools);
  const pluginData = join(home, '.claude', 'plugins', 'data', 'aeolus-fleet-aeolus-fleet');
  const codexPluginData = join(home, '.codex', 'plugins', 'data', 'aeolus-fleet-aeolus-fleet');
  script(join(bin, 'claude'), claudeStandIn({ machine, pluginData }));
  script(join(bin, 'systemctl'), systemctlStandIn({ machine, home }));
  if (others.includes('codex')) {
    script(join(bin, 'codex'), codexStandIn({ machine, pluginData: codexPluginData }));
  }
  if (others.includes('copilot')) {
    script(join(bin, 'copilot'), copilotStandIn({ machine, pluginData: join(home, '.copilot', 'plugin-data', 'aeolus-fleet', 'aeolus-fleet') }));
    // The aeolus-fleet plugin as Copilot installs it: this repository's own.
    const installed = join(home, '.copilot', 'installed-plugins', 'aeolus-fleet');
    mkdirSync(installed, { recursive: true });
    symlinkSync(PLUGIN_ROOT, join(installed, 'aeolus-fleet'));
  }
  const repository = join(home, 'aeolus-fleet');
  await git(['init', '-q', '-b', 'main', repository]);
  writeFileSync(join(repository, 'README.md'), 'hello\n');
  await git(['-C', repository, 'add', '.']);
  await git(['-C', repository, 'commit', '-q', '-m', 'init']);
  const env = {
    HOME: home,
    PATH: `${bin}:${tools}`,
    LANG: 'C.UTF-8',
    ...GIT_ENV,
    // The aeolus-fleet plugin as Claude Code would have installed it: this repository's own.
    AEOLUS_PLUGIN_ROOT: PLUGIN_ROOT,
    AEOLUS_PLUGIN_DATA: pluginData,
    AEOLUS_CODEX_PLUGIN_ROOT: PLUGIN_ROOT,
    AEOLUS_CODEX_PLUGIN_DATA: codexPluginData,
  };
  const servicePid = (): number | undefined => {
    const file = join(machine, 'systemd', 'pid');
    return existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) : undefined;
  };
  // A trierarch that is one file is copied, as an install puts it in the user's own folder; one run by an interpreter is run as it is.
  const [program = '', ...programWords] = TRIERARCH_UNDER_TEST;
  const installed = join(home, '.local', 'bin', 'aeolus-trierarch');
  const isOneFile = !isTodaysTrierarch && programWords.length === 0;
  const underTest = isOneFile ? [installed] : TRIERARCH_UNDER_TEST;
  if (isOneFile) {
    mkdirSync(dirname(installed), { recursive: true });
    copyFileSync(program, installed);
    chmodSync(installed, 0o755);
  }
  const trierarch = (words: readonly string[], at: { input?: string; as?: readonly string[]; env?: Readonly<Record<string, string>> } = {}) =>
    runProgram([...(at.as ?? underTest), ...words], { cwd: home, env: { ...env, ...at.env }, ...(at.input !== undefined && { input: at.input }) });
  return {
    home,
    machine,
    trierarchHome: join(home, '.aeolus', 'trierarch'),
    repository,
    pluginData,
    underTest,
    trierarch,
    toggle: (name, isOn) => {
      const file = join(machine, name);
      if (isOn) {
        writeFileSync(file, '');
      } else {
        rmSync(file, { force: true });
      }
    },
    servicePid,
    serviceLog: () => readFileSync(join(machine, 'systemd', 'trierarch.log'), { encoding: 'utf8', flag: 'a+' }),
    callsOf: (harness) =>
      readFileSync(join(machine, `${harness}-calls.txt`), { encoding: 'utf8', flag: 'a+' })
        .split('\n')
        .filter((line) => line !== ''),
    remove: async () => {
      // uninstall stops every session and the service, as it does on a machine; the service's pid is ended too when it did not.
      await trierarch(['uninstall']);
      const pid = servicePid();
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Ended already.
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
