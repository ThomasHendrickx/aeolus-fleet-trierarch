import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { cappedLogStream, isWritingTo } from '../adapters/capped-log.js';
import { createClaudeCodeSetup } from '../adapters/claude-code-setup.js';
import { createCodexSetup } from '../adapters/codex-setup.js';
import { createContainerHost } from '../adapters/container-host.js';
import { createDetectedFile } from '../adapters/detected-file.js';
import { createDetectors } from '../adapters/detectors.js';
import { loadConfiguration, readCrewFile, readRunningFile, removeRemoteControl, TrierarchFileError } from '../adapters/files.js';
import { createJsonState } from '../adapters/json-state.js';
import { createKeyFiles } from '../adapters/key-files.js';
import { createLogger, readLogLine, renderLogLine, type LogStream } from '../adapters/log.js';
import { createStyle, isColourTerminal, type Style } from '../adapters/style.js';
import { trierarchPaths } from '../adapters/paths.js';
import { aeolusPluginVersion, PLUGIN_HARNESSES, type PluginHarness } from '../adapters/plugin.js';
import { createPluginUpdate } from '../adapters/plugin-update.js';
import { createRestFleet } from '../adapters/rest-fleet.js';
import { runCommand, streamCommand } from '../adapters/run-command.js';
import { createService, serviceEnvironment, systemctlEnvironment } from '../adapters/service.js';
import { hostSessions, modelProxy } from '../adapters/runtime-adapters.js';
import { checkKey } from '../adapters/vendor-key-check.js';
import { CHECK_PATH } from '../adapters/model-proxy.js';
import { runningVersion } from '../adapters/version.js';
import { KEY_STATES, type Login } from '../core/login.js';
import { createDetectHarnesses } from '../core/detect-harnesses.js';
import { createUninstall } from '../core/uninstall.js';
import { configCheck } from './config-check.js';
import { detectOptions } from './detect.js';
import { addPlace } from './add.js';
import { initTrierarch } from './init.js';
import { describeList, inspectList } from './list.js';
import { login, readKeyFrom, type LoginRequest } from './login.js';
import { createServiceLog } from './logs.js';
import { createTerminalPrompter } from './prompter.js';
import { runTrierarch } from './run.js';
import { describeService, runServiceCommand } from './service-command.js';
import { describeStatus, inspectStatus, leaseFrom } from './status.js';
import { uninstallTrierarch } from './uninstall.js';
import { PACKAGE, upgradeTrierarch } from './upgrade.js';

export const USAGE = [
  'Usage: aeolus-trierarch <command> [--config <path>] [--json]',
  '       aeolus-trierarch --version   the installed version (also -v)',
  '',
  'Set up:',
  "  init [--fleet-url <url>] [--ship-id <shp_...>] [--plugin-ship-id <shp_...>] [--secret <secret>] [--yes]   the whole setup: registers the trierarch's own ship, keeps the trierarch plugin's ship the trusted repositories come from, writes the configuration, answers Claude Code's and Codex's one-time questions and offers to install the service. Asks for what is missing; prefer typing the secret when asked, so it stays out of your shell history",
  '  add repository <name> <path>   add a repository to make worktrees of, trusted for every configured harness, and restart the service; sessions keep running',
  '  add folder <name> <path>       add a folder to crew a ship in as it is, the same way',
  '  config check          check the configuration and give the effective flags per harness',
  '  detect                detect again what each configured harness offers (models, effort) and keep it beside the configuration',
  '  login                 each harness\'s login and whether it holds an API key',
  '  login <harness> --api-key      read an API key for claude-code or codex from stdin (not shown as typed), check it with the vendor and keep it on this computer only, then restart the service; sessions keep running',
  '  login <harness> --remove-key   remove the API key for that harness, then restart the service',
  '  login <harness> --check        check an API key out of credit at once, as the model proxy does every 15 minutes',
  '  login <harness> --default api-key|subscription   the login that harness\'s sessions run on, from each one\'s next start, then restart the service',
  '  login --ship <name> api-key|subscription|default  the login that ship runs on, or its harness\'s default again, from its next start, then restart the service',
  '',
  'Look:',
  '  status                the version, the aeolus-fleet plugin per harness, the repositories, the service, the fleet and its own lease, caps in use, entries by state, kept worktrees and orphans',
  '  list                  the ships it crews: ship, state, harness, workspace, since, restarts',
  '  logs [--lines <n>] [--follow]   the last lines of the log (the journal on Linux), and with --follow each new one',
  '',
  'Run:',
  '  start                 start the service',
  '  stop                  stop the service (it starts again at the next login)',
  '  restart               restart the service, so it reads a changed configuration',
  '  upgrade [version]     install the given version, or the latest, update the aeolus-fleet plugin and restart the service; sessions keep running',
  '  install [--no-load]   install the service: launchd on macOS, systemd on Linux',
  '  uninstall             remove the service and stop every session; deletes no worktree and none of its files',
  '  run                   keep the ships assigned to it crewed until stopped (what the service runs)',
  '',
  '--json answers JSON, for a ship to read.',
].join('\n');

/** The command's own words: its output and its exit code. */
export interface Outcome {
  readonly output: string;
  readonly code: number;
}

/** What a command answers: data for --json, words for the operator. */
interface Answer {
  readonly data: unknown;
  readonly text: string;
  /** The exit code when the command did not do all it was asked; 0 otherwise. */
  readonly code?: number;
}

const VALUE_FLAGS = new Set(['--config', '--fleet-url', '--ship-id', '--plugin-ship-id', '--secret', '--lines', '--default', '--ship']);
/** Set for the installed version's upgrade that runs the plugin step of an upgrade (#725), which restarts the service itself (#829); older versions ignore it. */
const PLUGIN_STEP_VARIABLE = 'AEOLUS_TRIERARCH_PLUGIN_STEP';

const SWITCHES = new Set(['--json', '--yes', '--follow', '--no-load', '--version', '--api-key', '--remove-key', '--check']);
const DEFAULT_LINES = 50;
const FOLLOW_INTERVAL_MS = 500;

/** The command words, flag values and switches of a command line; undefined for a flag it does not know. */
function parse(argv: readonly string[]): { words: string[]; values: Map<string, string>; switches: Set<string> } | undefined {
  const words: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) {
      words.push(arg);
      continue;
    }
    const [name = '', inline] = arg.split(/=(.*)/s);
    if (SWITCHES.has(name) && inline === undefined) {
      switches.add(name);
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[(index += 1)];
      if (value === undefined) {
        return undefined;
      }
      values.set(name, value);
    } else {
      return undefined;
    }
  }
  return { words, values, switches };
}

/** What init did, at the end of its steps: a heading, then each thing it did on its own line. */
function summaryOf(said: readonly string[], style: Style): string {
  return [`\n${style.tone('strong', 'Summary')}`, ...said.map((line) => `  ${line}`)].join('\n');
}

/** What a command line reads of the machine: its environment, where Claude Code's managed settings live, a folder of its own in a test (#516), and its platform, which says where the service writes its log (#474). */
export interface Machine {
  env: Readonly<Record<string, string | undefined>>;
  managedSettings: string;
  platform: string;
}

/** A key's state as the model proxy answers a check. */
const keyStateAtSchema = z.object({ state: z.enum(KEY_STATES), at: z.string().optional() });

/** The login a command line names: api-key or subscription, and default where it may clear one. */
const LOGIN_WORDS: Readonly<Record<string, Login | 'default' | undefined>> = { 'api-key': 'apiKey', subscription: 'subscription', default: 'default' };

/** What a login command line asks: show with nothing more, a ship's login with --ship, else a key to read or remove or a default for the harness it names. */
function loginRequest(word: string | undefined, at: { switches: ReadonlySet<string>; values: ReadonlyMap<string, string> }): LoginRequest {
  const isApiKey = at.switches.has('--api-key');
  const isRemoveKey = at.switches.has('--remove-key');
  const isCheck = at.switches.has('--check');
  const shipName = at.values.get('--ship');
  const defaultWord = at.values.get('--default');
  if (shipName !== undefined) {
    const login = LOGIN_WORDS[word ?? ''];
    if (login === undefined) {
      throw new TrierarchFileError('A ship\'s login is api-key, subscription or default: aeolus-trierarch login --ship build-docs api-key');
    }
    return { kind: 'setShip', shipName, login };
  }
  if (word === undefined && !isApiKey && !isRemoveKey && !isCheck && defaultWord === undefined) {
    return { kind: 'show' };
  }
  if (word === 'copilot') {
    // Copilot signs in with the machine's own login (CC6): it has no API key, default or check to set.
    throw new TrierarchFileError("Copilot signs in with this computer's own login (copilot login), never an API key: the trierarch keeps no Copilot key and runs every Copilot session on that login");
  }
  const harness = PLUGIN_HARNESSES.find((name): name is PluginHarness => name === word);
  if (harness === undefined || [isApiKey, isRemoveKey, isCheck, defaultWord !== undefined].filter(Boolean).length !== 1) {
    throw new TrierarchFileError(`login takes ${PLUGIN_HARNESSES.join(' or ')}: aeolus-trierarch login claude-code --api-key`);
  }
  if (defaultWord !== undefined) {
    const login = LOGIN_WORDS[defaultWord];
    if (login === undefined || login === 'default') {
      throw new TrierarchFileError(`A login is api-key or subscription: aeolus-trierarch login ${harness} --default api-key`);
    }
    return { kind: 'setDefault', harness, login };
  }
  return { kind: isApiKey ? 'apiKey' : isCheck ? 'check' : 'removeKey', harness };
}

/** Runs one command line of `aeolus-trierarch`. */
export async function main(argv: readonly string[], machine: Machine): Promise<Outcome> {
  const { env, platform } = machine;
  const parsed = parse(argv);
  if (parsed === undefined) {
    return { output: USAGE, code: 2 };
  }
  const { words, values, switches } = parsed;
  const isJson = switches.has('--json');
  // Colour only where a person reads it: --json and a pipe get the plain words.
  const style = createStyle({ isColour: !isJson && isColourTerminal(env, process.stdout.isTTY) });
  if ((switches.has('--version') && words.length === 0) || (words.length === 1 && words[0] === '-v')) {
    const version = runningVersion();
    return { output: isJson ? JSON.stringify({ version }) : version, code: 0 };
  }
  const config = values.get('--config') ?? env.AEOLUS_TRIERARCH_CONFIG;
  const homeDirectory = env.HOME ?? homedir();
  const paths = trierarchPaths({ homeDirectory, ...(config !== undefined && { config }) });
  // The installed package's own command: an upgrade puts the new version's code here.
  const script = fileURLToPath(new URL('../bin/aeolus-trierarch.js', import.meta.url));
  const uid = process.getuid?.() ?? 0;
  const serviceAt = () =>
    createService({
      platform,
      homeDirectory,
      paths,
      run: { node: process.execPath, script },
      environment: serviceEnvironment(env),
      uid,
      exec: (program, args) => runCommand(program, { args, ...(program === 'systemctl' && { env: systemctlEnvironment(env, uid) }) }),
      now: () => new Date(),
    });
  // Claude Code's files where Claude Code keeps them: under CLAUDE_CONFIG_DIR when it is set (#474).
  const claudeCodeSetup = () => createClaudeCodeSetup({ homeDirectory, managedSettings: machine.managedSettings, ...(env.CLAUDE_CONFIG_DIR !== undefined && { configDirectory: env.CLAUDE_CONFIG_DIR }) });
  const untilStopped = (): AbortSignal => {
    const stopping = new AbortController();
    process.once('SIGINT', () => {
      stopping.abort();
    });
    process.once('SIGTERM', () => {
      stopping.abort();
    });
    return stopping.signal;
  };

  const inspect = async (): Promise<Answer> => {
    const crew = await readCrewFile(paths.crewToken);
    const configuration = await loadConfiguration(paths.config);
    const fleet = createRestFleet(crew);
    const report = await inspectStatus({
      configuration,
      version: runningVersion(),
      pluginVersion: (harness) => aeolusPluginVersion({ homeDirectory, env, harness }),
      running: () => readRunningFile(paths.running),
      crew,
      service: serviceAt(),
      lease: leaseFrom(() => fleet.whoami()),
      processes: hostSessions({ paths, version: runningVersion() }),
      state: createJsonState(paths.state),
    });
    return { data: report, text: describeStatus(report, style) };
  };

  const detectAt = () =>
    createDetectHarnesses({
      detectors: createDetectors({ homeDirectory, env }),
      store: createDetectedFile(paths.detected),
      clock: { now: () => new Date() },
      logger: { warn: (message) => process.stderr.write(`${message}\n`) },
    });

  const commands: Record<string, (() => Promise<Answer>) | undefined> = {
    init: async () => {
      // Questions go to stderr under --json, so stdout holds the JSON alone.
      const output = isJson ? process.stderr : process.stdout;
      const prompter = createTerminalPrompter({ input: process.stdin, output, style: createStyle({ isColour: isColourTerminal(env, output.isTTY) }) });
      try {
        const fleetUrl = values.get('--fleet-url');
        const shipId = values.get('--ship-id');
        const secret = values.get('--secret');
        const pluginShipId = values.get('--plugin-ship-id');
        const report = await initTrierarch({
          homeDirectory,
          paths,
          flags: { ...(fleetUrl !== undefined && { fleetUrl }), ...(shipId !== undefined && { shipId }), ...(secret !== undefined && { secret }), ...(pluginShipId !== undefined && { pluginShipId }), isYes: switches.has('--yes') },
          prompter,
          fleetAt: (url, crewToken = '') => createRestFleet({ fleetUrl: url, crewToken }),
          claudeCode: claudeCodeSetup(),
          codex: createCodexSetup(),
          isCodexInstalled: (await runCommand('sh', { args: ['-c', 'command -v codex'] })).status === 0,
          isClaudeCodeInstalled: (await runCommand('sh', { args: ['-c', 'command -v claude'] })).status === 0,
          nodeVersion: process.versions.node,
          service: serviceAt(),
          running: () => readRunningFile(paths.running),
          detect: detectAt(),
        });
        return { data: report, text: summaryOf(report.said, style) };
      } finally {
        prompter.close();
      }
    },
    add: async () => {
      const [, kind, name, path] = words;
      if ((kind !== 'repository' && kind !== 'folder') || name === undefined || path === undefined) {
        throw new TrierarchFileError('add takes repository or folder, a name and a path: aeolus-trierarch add repository pagasae ~/Projects/pagasae');
      }
      const report = await addPlace({ kind, name, path, paths, homeDirectory, claudeCode: claudeCodeSetup(), codex: createCodexSetup(), service: serviceAt(), running: () => readRunningFile(paths.running) });
      return { data: report, text: report.said.join('\n') };
    },
    'config check': async () => {
      const { text, ...data } = await configCheck(paths, { files: { claudeCode: claudeCodeSetup() }, host: createContainerHost({ modelTokenFile: paths.modelToken }) });
      return { data, text };
    },
    login: async () => {
      const report = await login({
        request: loginRequest(words[1], { switches, values }),
        config: paths.config,
        keys: createKeyFiles(paths.keys),
        readKey: async () => {
          if (!process.stdin.isTTY) {
            return readKeyFrom(process.stdin);
          }
          // Asked on stderr, so stdout holds the answer alone.
          const prompter = createTerminalPrompter({ input: process.stdin, output: process.stderr, style: createStyle({ isColour: isColourTerminal(env, process.stderr.isTTY) }) });
          try {
            return await prompter.secret('API key (not shown):');
          } finally {
            prompter.close();
          }
        },
        check: (harness, key) => checkKey({ harness, key }),
        checkNow: async (harness) => {
          const url = await modelProxy({ paths, version: runningVersion() }).url();
          const answer = url === undefined ? undefined : await fetch(`${url}${CHECK_PATH}${harness}`, { method: 'POST' }).catch(() => undefined);
          const key = keyStateAtSchema.safeParse(answer?.ok === true ? await answer.json().catch(() => undefined) : undefined);
          return key.success ? key.data : undefined;
        },
        service: serviceAt(),
        running: () => readRunningFile(paths.running),
      });
      return { data: report, text: report.said.join('\n') };
    },
    detect: async () => {
      const { text, ...data } = await detectOptions({ configuration: await loadConfiguration(paths.config), detect: detectAt() });
      return { data, text };
    },
    status: inspect,
    upgrade: async () => {
      const version = words[1];
      // No configuration yet: the trierarch offers no harness, and updates no plugin.
      const configuration = await loadConfiguration(paths.config).catch(() => undefined);
      const pluginUpdate = createPluginUpdate({ homeDirectory, env, trierarchPid: async () => (await readRunningFile(paths.running))?.pid });
      const report = await upgradeTrierarch({
        ...(version !== undefined && { version }),
        isPluginStepOfAnUpgrade: env[PLUGIN_STEP_VARIABLE] === '1',
        removeRemoteControl: () => removeRemoteControl(paths.config),
        installedVersion: runningVersion,
        npm: {
          globalFolder: async () => {
            const path = (await runCommand('npm', { args: ['root', '--global'] })).stdout.trim();
            const isWritable = await access(path, constants.W_OK).then(
              () => true,
              () => false,
            );
            return { path, isWritable };
          },
          latest: async () => (await runCommand('npm', { args: ['view', PACKAGE, 'version'] })).stdout,
          install: (spec) => runCommand('npm', { args: ['install', '--global', spec] }),
        },
        writeInstalledServiceFile: () => runCommand(process.execPath, { args: [script, 'install', '--no-load', ...(config !== undefined ? ['--config', config] : [])] }),
        upgradeInstalledPlugin: (to) => runCommand(process.execPath, { args: [script, 'upgrade', to, '--json', ...(config !== undefined ? ['--config', config] : [])], env: { [PLUGIN_STEP_VARIABLE]: '1' } }),
        service: serviceAt(),
        running: () => readRunningFile(paths.running),
        plugin: {
          harnesses: PLUGIN_HARNESSES.filter((harness) => configuration?.harnesses[harness] !== undefined),
          update: (harness, tag) => pluginUpdate.update(harness, tag),
          version: (harness) => aeolusPluginVersion({ homeDirectory, env, harness }),
          trustCodexHooks: () => createCodexSetup().trustAeolusHooks(configuration?.worktreeRoot ?? paths.worktrees),
        },
      });
      // A plugin that could not be updated is said, and shows in the exit code (#581).
      const code = report.isPluginUpdated ? 0 : 1;
      if (!report.isUpgraded) {
        return { data: report, text: report.said.join('\n'), code };
      }
      const status = await inspect();
      return { data: { ...report, status: status.data }, text: [...report.said, '', status.text].join('\n'), code };
    },
    list: async () => {
      const entries = await inspectList(createJsonState(paths.state));
      return { data: entries, text: describeList(entries, style) };
    },
    logs: async () => {
      const log = createServiceLog({ platform, file: join(paths.logs, 'trierarch.log'), exec: (program, args) => runCommand(program, { args }), stream: streamCommand });
      const lines = Number(values.get('--lines') ?? DEFAULT_LINES);
      if (!Number.isInteger(lines) || lines < 0) {
        throw new TrierarchFileError('--lines takes a whole number');
      }
      const tail = await log.tail(lines);
      if (!switches.has('--follow')) {
        const where = 'file' in log.where ? log.where.file : `the journal (${log.where.journal})`;
        return { data: { ...log.where, lines: tail.map(readLogLine) }, text: tail.length === 0 ? `No log lines yet in ${where}.` : tail.map((line) => renderLogLine(line, style)).join('\n') };
      }
      const write = (line: string): void => {
        process.stdout.write(`${isJson ? JSON.stringify(readLogLine(line)) : renderLogLine(line, style)}\n`);
      };
      tail.forEach(write);
      await log.follow({ signal: untilStopped(), intervalMs: FOLLOW_INTERVAL_MS, write });
      return { data: undefined, text: '' };
    },
    start: async () => {
      const { status, text } = await runServiceCommand({ command: 'start', service: serviceAt(), logs: paths.logs, running: () => readRunningFile(paths.running) });
      return { data: status, text };
    },
    stop: async () => {
      const service = serviceAt();
      await service.stop();
      const status = await service.status();
      return { data: status, text: `${describeService('stopped', status)} It starts again at the next login, or with aeolus-trierarch start.` };
    },
    restart: async () => {
      const { status, text } = await runServiceCommand({ command: 'restart', service: serviceAt(), logs: paths.logs, running: () => readRunningFile(paths.running) });
      return { data: status, text };
    },
    install: async () => {
      if (switches.has('--no-load')) {
        const service = serviceAt();
        await service.write();
        const status = await service.status();
        return { data: status, text: `Installed ${status.file}. Logs: ${paths.logs}` };
      }
      const { status, text } = await runServiceCommand({ command: 'install', service: serviceAt(), logs: paths.logs, running: () => readRunningFile(paths.running) });
      return { data: status, text };
    },
    uninstall: async () => {
      const report = await uninstallTrierarch({ service: serviceAt(), uninstall: createUninstall({ processes: hostSessions({ paths, version: runningVersion() }), state: createJsonState(paths.state) }), home: paths.home });
      return { data: report, text: report.said.join('\n') };
    },
    run: async () => {
      const now = (): Date => new Date();
      // Where launchd writes stdout and stderr to the log file, the trierarch caps it; the journal caps itself.
      const file = join(paths.logs, 'trierarch.log');
      const capped = (stream: LogStream, descriptor: number): LogStream => (isWritingTo(descriptor, file) ? cappedLogStream({ file, stream, now }) : stream);
      const logger = createLogger({
        out: capped({ write: (text) => process.stdout.write(text), isTerminal: process.stdout.isTTY }, process.stdout.fd),
        err: capped({ write: (text) => process.stderr.write(text), isTerminal: process.stderr.isTTY }, process.stderr.fd),
        now,
      });
      await runTrierarch({ paths, homeDirectory, env, managedSettings: machine.managedSettings, signal: untilStopped(), logger });
      return { data: { stopped: true }, text: 'aeolus-trierarch stopped.' };
    },
  };

  // upgrade takes a word after it, the version; add takes three, the kind, the name and the path; login one, the harness.
  const command = (words[0] === 'upgrade' || words[0] === 'login') && words.length <= 2 ? commands[words[0]] : words[0] === 'add' && words.length === 4 ? commands.add : commands[words.join(' ')];
  if (command === undefined) {
    return { output: USAGE, code: 2 };
  }
  try {
    const { data, text, code = 0 } = await command();
    return { output: isJson && data !== undefined ? JSON.stringify(data, null, 2) : text, code };
  } catch (error) {
    // A refusal, a file it cannot use, or a program that failed (launchctl, systemctl): said, not thrown at the operator.
    const message = error instanceof Error ? error.message : String(error);
    return { output: isJson ? JSON.stringify({ error: message }) : style.tone('bad', message), code: 1 };
  }
}
