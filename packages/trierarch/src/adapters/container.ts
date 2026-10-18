import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { idSchema, type ShipId } from '@aeolus-fleet/common';

import type { ObservedSession, SessionRuntime } from '../core/ports.js';
import type { SessionRoots } from './caller-check.js';
import { heldCommand } from './held-command.js';
import { shipHome } from './paths.js';
import { runCommand, type CommandResult } from './run-command.js';

const PREFIX = 'trierarch-';
const OWNER_LABEL = 'aeolus.trierarch';
const CONTAINER_OWNER = 'aeolus-trierarch';
/** The variable Claude Code reads its long-lived model token from (`claude setup-token`). */
export const MODEL_TOKEN_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';
/** The session user's home in the image, where each container gets its ship's own home. */
export const SESSION_HOME = '/home/ubuntu';
/** The image's session user (ubuntu), whose subordinate ids the nested Podman maps. */
const SESSION_USER = 'uid=1000,gid=1000';
/** The tmux session inside each container: one per container, so one name serves. */
const TMUX_TARGET = '=session:';
/**
 * The most processes and threads a container may hold, a hard cap beside
 * memory and cpus (decision 0039): room for Claude Code, a test run with its
 * workers, a browser and a nested Postgres, and none for a runaway fork.
 */
const PIDS_LIMIT = 4096;
/** How many lines back a screen is read, as on the host. */
const SCREEN_LINES = 200;

/**
 * The container's command: tmux runs the session's command, keeping its pane
 * on exit, as on the host. Once the command ends, it prints the pane and ends,
 * so the container exits and the runtime's log keeps the last screen. The pane
 * starts with the shell and is respawned with the command once remain-on-exit
 * is set, so even a command that ends at once leaves its exit to see.
 */
const SESSION_SCRIPT = `
tmux new-session -d -s session -x 200 -y 50 || exit 1
tmux set-option -w -t '${TMUX_TARGET}' remain-on-exit on
tmux respawn-pane -k -t '${TMUX_TARGET}' -- "$@"
while [ "$(tmux display-message -p -t '${TMUX_TARGET}' '#{pane_dead}' 2> /dev/null)" = 0 ]; do sleep 1; done
tmux capture-pane -p -J -S -${String(SCREEN_LINES)} -t '${TMUX_TARGET}'
`;

type Run = (command: string, options: { args: readonly string[] }) => Promise<CommandResult>;

export interface ContainerRuntimeOptions {
  /** The docker-style binary of a rootless runtime: podman on Linux, docker in a Colima context on macOS. */
  readonly binary: string;
  readonly image: string;
  /** The file holding the machine's long-lived model token, read at every start. */
  readonly tokenFile: string;
  /** Where the ships' homes are kept on the host, one folder per ship, each mounted as its container's home. */
  readonly homes: string;
  /** Where the ships' sockets are kept on the host, one folder per ship, each mounted at its own path (decision 0026). */
  readonly sockets: string;
  /** The memory cap of each container, as the runtime takes it (`4g`). */
  readonly memory: string;
  readonly cpus: number;
  /** Tells this trierarch's containers apart from any other on the machine. */
  readonly owner?: string;
  /** What the runtime's run goes through: a systemd scope of its own under a systemd unit (see sessionsLaunch). */
  readonly launch?: readonly string[];
  readonly run?: Run;
}

function containerName(shipId: ShipId): string {
  return `${PREFIX}${shipId}`;
}

/** The env file's lines; a value over more than one line has no place in one. */
function envFileOf(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([variable, value]) => {
      if (value.includes('\n')) {
        throw new Error(`the environment value of ${variable} spans more than one line, which an env file cannot hold`);
      }
      return `${variable}=${value}\n`;
    })
    .join('');
}

/**
 * The container session runtime (decision 0039): one container per ship,
 * named after its ship id, with tmux inside, so typing and screen reads are an
 * exec into it. Rootless only, with hard memory and cpu caps and no restart
 * policy: the trierarch starts a dead container again itself. The container
 * sees its folder, its ship's own home, as its home, and its ship's socket
 * folder, at its own path, and nothing else of the host, never the runtime's
 * socket. The home is made, for its owner
 * alone, when the ship has none yet.
 *
 * The model token and the session's environment reach the container through
 * an env file only its owner reads, removed once the container runs, never a
 * command line (#445). Under a systemd unit the run goes through a scope of its
 * own, so the container's monitor is not in the service's control group and a
 * restart or upgrade ends no session (#479, #537).
 */
export function createContainerRuntime(options: ContainerRuntimeOptions): SessionRuntime & SessionRoots {
  const owner = options.owner ?? CONTAINER_OWNER;
  const launch = options.launch ?? [];
  const run = options.run ?? runCommand;
  const runtime = async (args: readonly string[]): Promise<CommandResult> => run(options.binary, { args });
  const must = async (args: readonly string[]): Promise<string> => {
    const result = await runtime(args);
    if (result.status !== 0) {
      throw new Error(`${options.binary} ${args[0] ?? ''} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
  const stop = async (shipId: ShipId): Promise<void> => {
    // Kill, then remove: a remove alone waits out the stop timeout on podman.
    await runtime(['kill', containerName(shipId)]);
    await runtime(['rm', '--force', containerName(shipId)]);
  };
  const tmux = (shipId: ShipId, args: readonly string[]): readonly string[] => ['exec', containerName(shipId), 'tmux', ...args];

  return {
    list: async () => {
      const listed = await must(['ps', '--all', '--filter', `label=${OWNER_LABEL}=${owner}`, '--format', '{{.Names}} {{.State}}']);
      return listed.split('\n').flatMap((line): ObservedSession[] => {
        const [name = '', state = ''] = line.trim().split(' ');
        const shipId = idSchema('ship').safeParse(name.slice(PREFIX.length));
        return name.startsWith(PREFIX) && shipId.success ? [{ shipId: shipId.data, status: state === 'running' ? 'running' : 'exited' }] : [];
      });
    },
    stop,
    start: async ({ shipId, folder, command, env = {} }) => {
      const token = (await readFile(options.tokenFile, 'utf8')).trim();
      const content = envFileOf({ ...env, [MODEL_TOKEN_VARIABLE]: token });
      await stop(shipId);
      const home = shipHome(options.homes, shipId);
      const shipSockets = join(options.sockets, shipId);
      // The runtime mounts only a folder that exists, and the ship's socket may not have made it yet.
      await mkdir(shipSockets, { recursive: true, mode: 0o700 });
      await mkdir(home, { recursive: true, mode: 0o700 });
      const secrets = await mkdtemp(join(tmpdir(), 'aeolus-trierarch-env-'));
      try {
        const envFile = join(secrets, 'session.env');
        await writeFile(envFile, content, { mode: 0o600 });
        const [program = options.binary, ...args] = [
          ...launch,
          options.binary,
          'run',
          '--detach',
          '--name',
          containerName(shipId),
          '--label',
          `${OWNER_LABEL}=${owner}`,
          // Without it, podman lets swap double the memory cap.
          '--memory-swap',
          options.memory,
          '--memory',
          options.memory,
          '--cpus',
          String(options.cpus),
          '--pids-limit',
          String(PIDS_LIMIT),
          `--userns=keep-id:${SESSION_USER}`,
          '--device',
          '/dev/fuse',
          '--device',
          '/dev/net/tun',
          '--cap-add',
          'SYS_ADMIN',
          '--security-opt',
          'unmask=ALL',
          '--volume',
          `${folder}:${folder}`,
          '--volume',
          `${home}:${SESSION_HOME}`,
          // The session calls the fleet over its ship's socket, at the path its identity names.
          '--volume',
          `${shipSockets}:${shipSockets}`,
          '--env',
          `HOME=${SESSION_HOME}`,
          '--workdir',
          folder,
          '--env-file',
          envFile,
          options.image,
          'sh',
          '-c',
          SESSION_SCRIPT,
          'sh',
          ...heldCommand(command),
        ];
        const started = await run(program, { args });
        if (started.status !== 0) {
          throw new Error(`${options.binary} run failed: ${started.stderr.trim()}`);
        }
      } finally {
        await rm(secrets, { recursive: true, force: true });
      }
    },
    type: async ({ shipId, text, settleMs }) => {
      await must(tmux(shipId, ['send-keys', '-t', TMUX_TARGET, '-l', text]));
      if (settleMs !== undefined) {
        await wait(settleMs);
      }
      await must(tmux(shipId, ['send-keys', '-t', TMUX_TARGET, 'Enter']));
    },
    interrupt: async (shipId) => {
      await must(tmux(shipId, ['send-keys', '-t', TMUX_TARGET, 'Escape']));
    },
    screen: async (shipId) => {
      const shown = await runtime(tmux(shipId, ['capture-pane', '-p', '-J', '-S', `-${String(SCREEN_LINES)}`, '-t', TMUX_TARGET]));
      if (shown.status === 0) {
        return shown.stdout;
      }
      // An exited container printed its last screen as it ended.
      const logged = await runtime(['logs', containerName(shipId)]);
      return logged.status === 0 ? logged.stdout : '';
    },
    // The container's first process as the host sees it: every process of the session runs under it; 0 once it runs no more.
    sessionRootOf: async (shipId) => {
      const inspected = await runtime(['inspect', '--format', '{{.State.Pid}}', containerName(shipId)]);
      const pid = Number(inspected.stdout.trim());
      return inspected.status === 0 && Number.isInteger(pid) && pid > 1 ? pid : undefined;
    },
  };
}
