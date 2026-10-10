import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClaudeCodeSetup } from '../adapters/claude-code-setup.js';
import { createCodexSetup } from '../adapters/codex-setup.js';
import { createDetectedFile } from '../adapters/detected-file.js';
import { createDetectors } from '../adapters/detectors.js';
import { loadConfiguration, readCrewFile, readRunningFile, TrierarchFileError } from '../adapters/files.js';
import { createJsonState } from '../adapters/json-state.js';
import { createLogger, readLogLine, renderLogLine } from '../adapters/log.js';
import { createStyle, isColourTerminal, type Style } from '../adapters/style.js';
import { trierarchPaths } from '../adapters/paths.js';
import { createRestFleet } from '../adapters/rest-fleet.js';
import { runCommand } from '../adapters/run-command.js';
import { createService, serviceEnvironment } from '../adapters/service.js';
import { createTmux } from '../adapters/tmux.js';
import { runningVersion } from '../adapters/version.js';
import { createDetectHarnesses } from '../core/detect-harnesses.js';
import { createUninstall } from '../core/uninstall.js';
import { configCheck } from './config-check.js';
import { detectOptions } from './detect.js';
import { addPlace } from './add.js';
import { initTrierarch } from './init.js';
import { describeList, inspectList } from './list.js';
import { followLog, tailLog } from './logs.js';
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
  "  init [--fleet-url <url>] [--ship-id <shp_...>] [--secret <secret>] [--yes]   the whole setup: registers the trierarch's own ship, writes the configuration, answers Claude Code's and Codex's one-time questions and offers to install the service. Asks for what is missing; prefer typing the secret when asked, so it stays out of your shell history",
  '  add repository <name> <path>   add a repository to make worktrees of, trusted for every configured harness, and restart the service; sessions keep running',
  '  add folder <name> <path>       add a folder to crew a ship in as it is, the same way',
  '  config check          check the configuration and give the effective flags per harness',
  '  detect                detect again what each configured harness offers (models, effort) and keep it beside the configuration',
  '',
  'Look:',
  '  status                the version, the service, the fleet and its own lease, caps in use, entries by state, kept worktrees and orphans',
  '  list                  the ships it crews: ship, state, harness, workspace, since, restarts',
  '  logs [--lines <n>] [--follow]   the last lines of the log, and with --follow each new one',
  '',
  'Run:',
  '  start                 start the service',
  '  stop                  stop the service (it starts again at the next login)',
  '  restart               restart the service, so it reads a changed configuration',
  '  upgrade [version]     install the given version, or the latest, and restart the service; sessions keep running',
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
}

const VALUE_FLAGS = new Set(['--config', '--fleet-url', '--ship-id', '--secret', '--lines']);
const SWITCHES = new Set(['--json', '--yes', '--follow', '--no-load', '--version']);
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

/** Runs one command line of `aeolus-trierarch`. */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): Promise<Outcome> {
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
  const serviceAt = () =>
    createService({
      platform: process.platform,
      homeDirectory,
      paths,
      run: { node: process.execPath, script: fileURLToPath(new URL('../bin/aeolus-trierarch.js', import.meta.url)) },
      environment: serviceEnvironment(env),
      uid: process.getuid?.() ?? 0,
      exec: (program, args) => runCommand(program, { args }),
      now: () => new Date(),
    });
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
      running: () => readRunningFile(paths.running),
      crew,
      service: serviceAt(),
      lease: leaseFrom(() => fleet.whoami()),
      processes: createTmux(),
      state: createJsonState(paths.state),
    });
    return { data: report, text: describeStatus(report, style) };
  };

  const detectAt = () =>
    createDetectHarnesses({
      detectors: createDetectors({ homeDirectory }),
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
        const report = await initTrierarch({
          homeDirectory,
          paths,
          flags: { ...(fleetUrl !== undefined && { fleetUrl }), ...(shipId !== undefined && { shipId }), ...(secret !== undefined && { secret }), isYes: switches.has('--yes') },
          prompter,
          fleetAt: (url) => createRestFleet({ fleetUrl: url, crewToken: '' }),
          claudeCode: createClaudeCodeSetup({ homeDirectory }),
          codex: createCodexSetup(),
          isCodexInstalled: (await runCommand('sh', { args: ['-c', 'command -v codex'] })).status === 0,
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
      const report = await addPlace({ kind, name, path, paths, homeDirectory, claudeCode: createClaudeCodeSetup({ homeDirectory }), codex: createCodexSetup(), service: serviceAt(), running: () => readRunningFile(paths.running) });
      return { data: report, text: report.said.join('\n') };
    },
    'config check': async () => {
      const { text, ...data } = await configCheck(paths);
      return { data, text };
    },
    detect: async () => {
      const { text, ...data } = await detectOptions({ configuration: await loadConfiguration(paths.config), detect: detectAt() });
      return { data, text };
    },
    status: inspect,
    upgrade: async () => {
      const version = words[1];
      const report = await upgradeTrierarch({
        ...(version !== undefined && { version }),
        installedVersion: runningVersion,
        npm: {
          latest: async () => (await runCommand('npm', { args: ['view', PACKAGE, 'version'] })).stdout,
          install: (spec) => runCommand('npm', { args: ['install', '--global', spec] }),
        },
        service: serviceAt(),
        running: () => readRunningFile(paths.running),
      });
      if (!report.isUpgraded) {
        return { data: report, text: report.said.join('\n') };
      }
      const status = await inspect();
      return { data: { ...report, status: status.data }, text: [...report.said, '', status.text].join('\n') };
    },
    list: async () => {
      const entries = await inspectList(createJsonState(paths.state));
      return { data: entries, text: describeList(entries, style) };
    },
    logs: async () => {
      const file = join(paths.logs, 'trierarch.log');
      const lines = Number(values.get('--lines') ?? DEFAULT_LINES);
      if (!Number.isInteger(lines) || lines < 0) {
        throw new TrierarchFileError('--lines takes a whole number');
      }
      const tail = await tailLog({ file, lines });
      if (!switches.has('--follow')) {
        return { data: { file, lines: tail.map(readLogLine) }, text: tail.length === 0 ? `No log lines yet in ${file}.` : tail.map((line) => renderLogLine(line, style)).join('\n') };
      }
      const write = (line: string): void => {
        process.stdout.write(`${isJson ? JSON.stringify(readLogLine(line)) : renderLogLine(line, style)}\n`);
      };
      tail.forEach(write);
      await followLog({ file, signal: untilStopped(), intervalMs: FOLLOW_INTERVAL_MS, write });
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
      const report = await uninstallTrierarch({ service: serviceAt(), uninstall: createUninstall({ processes: createTmux(), state: createJsonState(paths.state) }), home: paths.home });
      return { data: report, text: report.said.join('\n') };
    },
    run: async () => {
      const logger = createLogger({
        out: { write: (text) => process.stdout.write(text), isTerminal: process.stdout.isTTY },
        err: { write: (text) => process.stderr.write(text), isTerminal: process.stderr.isTTY },
        now: () => new Date(),
      });
      await runTrierarch({ paths, homeDirectory, env, signal: untilStopped(), logger });
      return { data: { stopped: true }, text: 'aeolus-trierarch stopped.' };
    },
  };

  // upgrade takes a word after it, the version; add takes three, the kind, the name and the path.
  const command = words[0] === 'upgrade' && words.length <= 2 ? commands.upgrade : words[0] === 'add' && words.length === 4 ? commands.add : commands[words.join(' ')];
  if (command === undefined) {
    return { output: USAGE, code: 2 };
  }
  try {
    const { data, text } = await command();
    return { output: isJson && data !== undefined ? JSON.stringify(data, null, 2) : text, code: 0 };
  } catch (error) {
    // A refusal, a file it cannot use, or a program that failed (launchctl, systemctl): said, not thrown at the operator.
    const message = error instanceof Error ? error.message : String(error);
    return { output: isJson ? JSON.stringify({ error: message }) : style.tone('bad', message), code: 1 };
  }
}
