import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TrierarchPaths } from './paths.js';
import type { CommandResult } from './run-command.js';

/**
 * The trierarch as a service of the operating system: `aeolus-trierarch run`
 * kept alive, started at login and again whenever it stops. A launchd agent
 * on macOS, a systemd user unit on Linux. Installing, starting, stopping and
 * asking how it runs go through `launchctl` or `systemctl --user`, and `ps`
 * for since when.
 */

export const LAUNCHD_LABEL = 'dev.aeolus-fleet.trierarch';
export const SYSTEMD_UNIT = 'aeolus-trierarch.service';

/** What runs the trierarch: this Node and this command's own file. */
export interface RunCommand {
  readonly node: string;
  readonly script: string;
}

/** How the service stands: its file, whether it is installed and running, and the running process. */
export interface ServiceStatus {
  readonly file: string;
  readonly isInstalled: boolean;
  readonly isRunning: boolean;
  readonly pid?: number;
  /** When the running process started, ISO 8601. */
  readonly since?: string;
}

export interface Service {
  /** Writes the service's file without loading it. */
  write(): Promise<void>;
  /** Writes the service's file over an installed one, for its next start, leaving the running trierarch and its sessions alone. */
  rewrite(): Promise<void>;
  /** Makes the supervisor read the service's file again, as written by this or another version, without restarting the trierarch. */
  reload(): Promise<void>;
  /** Writes the service's file, then loads and starts it. */
  install(): Promise<void>;
  /** Stops the service and removes its file. */
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

/** Runs a program and answers how it ended. */
export type Exec = (command: string, args: readonly string[]) => Promise<CommandResult>;

/** The variables the trierarch itself reads, carried into the service when set where install ran. */
const TRIERARCH_VARIABLES = ['AEOLUS_PLUGIN_ROOT', 'AEOLUS_PLUGIN_DATA', 'AEOLUS_CODEX_PLUGIN_ROOT', 'AEOLUS_CODEX_PLUGIN_DATA', 'CODEX_HOME', 'AEOLUS_TRIERARCH_CONFIG'] as const;

const DEFAULT_PATH = '/usr/bin:/bin';

/** The service's environment: PATH, so it finds tmux, git, claude and codex, and the trierarch's own variables. */
export function serviceEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const environment: Record<string, string> = { PATH: env.PATH ?? DEFAULT_PATH };
  for (const name of TRIERARCH_VARIABLES) {
    const value = env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function launchdPlist(at: { run: RunCommand; paths: TrierarchPaths; environment: Readonly<Record<string, string>> }): string {
  const strings = (values: readonly string[]) => values.map((value) => `    <string>${escapeXml(value)}</string>`).join('\n');
  const variables = Object.entries(at.environment)
    .map(([name, value]) => `    <key>${escapeXml(name)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([at.run.node, at.run.script, 'run'])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${variables}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(at.paths.logs, 'trierarch.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(at.paths.logs, 'trierarch.log'))}</string>
</dict>
</plist>
`;
}

function systemdUnit(at: { run: RunCommand; environment: Readonly<Record<string, string>> }): string {
  const variables = Object.entries(at.environment)
    .map(([name, value]) => `Environment="${name}=${value}"`)
    .join('\n');
  return `[Unit]
Description=Aeolus trierarch: keeps the ships assigned to it crewed on this machine

[Service]
ExecStart="${at.run.node}" "${at.run.script}" run
${variables}
Restart=always
RestartSec=5
# The sessions run in the tmux server the trierarch starts, in this unit's control group: a stop ends the trierarch only (#479).
KillMode=process

[Install]
WantedBy=default.target
`;
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const MS_PER_SECOND = 1000;

/** Seconds from `ps -o etime`: `[[dd-]hh:]mm:ss`. */
function elapsedSeconds(etime: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (match === null) {
    return undefined;
  }
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  return Number(days) * SECONDS_PER_DAY + Number(hours) * SECONDS_PER_HOUR + Number(minutes) * SECONDS_PER_MINUTE + Number(seconds);
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

/** How long stop and install wait for the service to be gone: checks, a second apart. */
const STOP_CHECKS = 30;
const STOP_CHECK_MS = 1000;

const NOT_INSTALLED = 'The service is not installed: run aeolus-trierarch install';

export function createService(options: {
  platform: string;
  homeDirectory: string;
  paths: TrierarchPaths;
  run: RunCommand;
  environment: Readonly<Record<string, string>>;
  uid: number;
  exec: Exec;
  now: () => Date;
  /** Waits between checks that a stopped service is gone; a test passes one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}): Service {
  const { platform, homeDirectory, paths, run, environment, uid, exec, now } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const must = async (command: string, args: readonly string[]): Promise<string> => {
    const result = await exec(command, args);
    if (result.status !== 0) {
      throw new Error(`${command} ${args[0] === '--user' ? `--user ${args[1] ?? ''}` : (args[0] ?? '')} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
  const since = async (pid: number): Promise<string | undefined> => {
    const elapsed = elapsedSeconds((await exec('ps', ['-o', 'etime=', '-p', String(pid)])).stdout);
    return elapsed === undefined ? undefined : new Date(now().getTime() - elapsed * MS_PER_SECOND).toISOString();
  };
  const running = async (file: string, pid: number | undefined): Promise<ServiceStatus> => {
    if (pid === undefined) {
      return { file, isInstalled: true, isRunning: false };
    }
    const started = await since(pid);
    return { file, isInstalled: true, isRunning: true, pid, ...(started !== undefined && { since: started }) };
  };

  if (platform === 'darwin') {
    const folder = join(homeDirectory, 'Library', 'LaunchAgents');
    const file = join(folder, `${LAUNCHD_LABEL}.plist`);
    const domain = `gui/${String(uid)}`;
    const target = `${domain}/${LAUNCHD_LABEL}`;
    const write = async (): Promise<void> => {
      await mkdir(paths.logs, { recursive: true });
      await mkdir(folder, { recursive: true });
      await writeFile(file, launchdPlist({ run, paths, environment }));
    };
    const isLoaded = async (): Promise<boolean> => (await exec('launchctl', ['print', target])).status === 0;
    const mustBeInstalled = async (): Promise<void> => {
      if (!(await exists(file))) {
        throw new Error(NOT_INSTALLED);
      }
    };
    const bootstrap = async (): Promise<void> => {
      await must('launchctl', ['bootstrap', domain, file]);
    };
    // Unloading, not killing: KeepAlive would start a killed one again. It loads again at the next login.
    // bootout returns before the process has exited: unloaded means launchd has the agent gone.
    const bootout = async (): Promise<void> => {
      await exec('launchctl', ['bootout', target]);
      for (let check = 0; await isLoaded(); check += 1) {
        if (check >= STOP_CHECKS) {
          throw new Error(`The trierarch still runs ${String((STOP_CHECKS * STOP_CHECK_MS) / MS_PER_SECOND)} s after it was stopped: see aeolus-trierarch status`);
        }
        await sleep(STOP_CHECK_MS);
      }
    };
    return {
      write,
      // launchd reads the file when it loads the agent again; the trierarch's own stop and start do.
      rewrite: write,
      reload: () => Promise.resolve(),
      install: async () => {
        await write();
        // Unload an earlier copy first: bootstrap refuses a loaded agent.
        await bootout();
        await bootstrap();
      },
      uninstall: async () => {
        await exec('launchctl', ['bootout', target]);
        await rm(file, { force: true });
      },
      start: async () => {
        await mustBeInstalled();
        await ((await isLoaded()) ? must('launchctl', ['kickstart', target]) : bootstrap());
      },
      stop: bootout,
      restart: async () => {
        await mustBeInstalled();
        await ((await isLoaded()) ? must('launchctl', ['kickstart', '-k', target]) : bootstrap());
      },
      status: async () => {
        if (!(await exists(file))) {
          return { file, isInstalled: false, isRunning: false };
        }
        const printed = await exec('launchctl', ['print', target]);
        const pid = printed.status === 0 ? /^\s*pid = (\d+)$/m.exec(printed.stdout)?.[1] : undefined;
        return running(file, pid === undefined ? undefined : Number(pid));
      },
    };
  }

  if (platform === 'linux') {
    const folder = join(homeDirectory, '.config', 'systemd', 'user');
    const file = join(folder, SYSTEMD_UNIT);
    const systemctl = async (...args: string[]): Promise<void> => {
      await must('systemctl', ['--user', ...args]);
    };
    const write = async (): Promise<void> => {
      await mkdir(paths.logs, { recursive: true });
      await mkdir(folder, { recursive: true });
      await writeFile(file, systemdUnit({ run, environment }));
    };
    // A reload, not a restart: systemd stops and starts the unit as the new file says from then on.
    const reload = async (): Promise<void> => {
      await systemctl('daemon-reload');
    };
    return {
      write,
      rewrite: async () => {
        await write();
        await reload();
      },
      reload,
      install: async () => {
        await write();
        await systemctl('daemon-reload');
        await systemctl('enable', SYSTEMD_UNIT);
        // restart, not start: an active unit runs the old file until it restarts. It starts an inactive one too.
        await systemctl('restart', SYSTEMD_UNIT);
      },
      uninstall: async () => {
        await exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
        await rm(file, { force: true });
        await exec('systemctl', ['--user', 'daemon-reload']);
      },
      start: async () => {
        await systemctl('start', SYSTEMD_UNIT);
      },
      stop: async () => {
        await systemctl('stop', SYSTEMD_UNIT);
      },
      restart: async () => {
        await systemctl('restart', SYSTEMD_UNIT);
      },
      status: async () => {
        if (!(await exists(file))) {
          return { file, isInstalled: false, isRunning: false };
        }
        const shown = (await exec('systemctl', ['--user', 'show', SYSTEMD_UNIT, '-p', 'ActiveState', '-p', 'MainPID'])).stdout;
        const isActive = /^ActiveState=active$/m.test(shown);
        const pid = Number(/^MainPID=(\d+)$/m.exec(shown)?.[1] ?? '0');
        return running(file, isActive && pid > 0 ? pid : undefined);
      },
    };
  }

  const elsewhere = (): Promise<never> =>
    Promise.reject(new Error(`aeolus-trierarch knows launchd (macOS) and systemd (Linux), not ${platform}: run aeolus-trierarch run under your own supervisor`));
  return { write: elsewhere, rewrite: elsewhere, reload: elsewhere, install: elsewhere, uninstall: elsewhere, start: elsewhere, stop: elsewhere, restart: elsewhere, status: elsewhere };
}
