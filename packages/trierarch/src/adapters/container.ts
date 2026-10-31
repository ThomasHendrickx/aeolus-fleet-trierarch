import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { idSchema, type ShipId } from '@aeolus-fleet/common';

import type { ObservedSession, SessionRuntime } from '../core/ports.js';
import type { SessionRoots } from './caller-check.js';
import { createHoldRuntime } from './hold-runtime.js';
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
/**
 * The most processes and threads a container may hold, a hard cap beside
 * memory and cpus (decision 0039): room for Claude Code, a test run with its
 * workers, a browser and a nested Postgres, and none for a runaway fork.
 */
const PIDS_LIMIT = 4096;
/**
 * Where a container reaches the host's loopback, and so the model proxy
 * (headless H16): the host's address in Podman's slirp4netns network, which
 * maps it to the host's loopback when the network allows that.
 */
export const MODEL_PROXY_HOST = '10.0.2.2';
/** The network that lets a session on an API key reach the host's loopback, and nothing more of the host than the network gives any container. */
const HOST_LOOPBACK_NETWORK = 'slirp4netns:allow_host_loopback=true';

/** Where a session in a container reaches the model proxy the trierarch reaches at the url, on the host's loopback. */
export function containerProxyUrl(url: string): string {
  const at = new URL(url);
  at.hostname = MODEL_PROXY_HOST;
  return at.origin;
}

/** The env file in the session's own folder, beside its hold's files. */
const ENV_FILE = 'session.env';

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
  /** The sessions folder: a folder per ship, with its hold's files and its env file. */
  readonly sessions: string;
  /** The trierarch program, which `hold` and its words follow. */
  readonly program: readonly string[];
  readonly version: string;
  readonly platform: string;
  /** Tells this trierarch's containers apart from any other on the machine. */
  readonly owner?: string;
  /** What a hold's start goes through: a systemd scope of its own under a systemd unit (see sessionsLaunch). */
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
 * The container session runtime (decision 0039, headless H18): one container
 * per ship, named after its ship id, run by the ship's hold on the host as
 * `run --rm -i`, attached: the hold holds the harness's input and output
 * through the runtime, so a line sent, an interrupt and the events are the
 * hold's, as on the host, and the container lives as long as the hold, a
 * signal to it reaching the harness through the image's tini. A container an
 * older trierarch started detached is listed as of another version until its
 * ship starts again (H19). Rootless only, with hard memory and cpu caps and no
 * restart policy: the trierarch starts a dead session again itself. The
 * container sees its folder, its ship's own home, as its home, and its ship's
 * socket folder, at its own path, and nothing else of the host, never the
 * runtime's socket. The home is made, for its owner alone, when the ship has
 * none yet.
 *
 * The model token and the session's environment reach the container through
 * an env file in the session's own folder, for its owner alone, never a
 * command line (#445). A session on an API key gets no model token, the
 * subscription's login: its proxy token, which its hold holds in the
 * environment it runs the container with, is passed on by its variable's name
 * alone, and the container reaches the host's loopback, where the model proxy
 * listens (headless H16, api keys K7). It is kept while the session runs, since the hold runs
 * the container again when it starts Claude Code again (H12), and goes with
 * the session's folder when it stops.
 */
export function createContainerRuntime(options: ContainerRuntimeOptions): SessionRuntime & SessionRoots {
  const owner = options.owner ?? CONTAINER_OWNER;
  const run = options.run ?? runCommand;
  const runtime = async (args: readonly string[]): Promise<CommandResult> => run(options.binary, { args });
  const must = async (args: readonly string[]): Promise<string> => {
    const result = await runtime(args);
    if (result.status !== 0) {
      throw new Error(`${options.binary} ${args[0] ?? ''} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
  /** The ship's container: stopped before its hold, so the hold ends with it, and listed where no hold holds the ship. */
  const containers: Pick<SessionRuntime, 'list' | 'stop'> = {
    list: async () => {
      const listed = await must(['ps', '--all', '--filter', `label=${OWNER_LABEL}=${owner}`, '--format', '{{.Names}} {{.State}}']);
      return listed.split('\n').flatMap((line): ObservedSession[] => {
        const [name = '', state = ''] = line.trim().split(' ');
        const shipId = idSchema('ship').safeParse(name.slice(PREFIX.length));
        return name.startsWith(PREFIX) && shipId.success ? [{ shipId: shipId.data, status: state === 'running' ? 'running' : 'exited' }] : [];
      });
    },
    stop: async (shipId) => {
      // Kill, then remove: a remove alone waits out the stop timeout on podman.
      await runtime(['kill', containerName(shipId)]);
      await runtime(['rm', '--force', containerName(shipId)]);
    },
  };

  const holds = createHoldRuntime({
    sessions: options.sessions,
    program: options.program,
    version: options.version,
    platform: options.platform,
    launch: options.launch ?? [],
    beside: containers,
    heldAs: async ({ shipId, folder, command, env = {}, readOnly = [], proxyToken }, files) => {
      const login: Record<string, string> = proxyToken === undefined ? { [MODEL_TOKEN_VARIABLE]: (await readFile(options.tokenFile, 'utf8')).trim() } : {};
      const content = envFileOf({ ...env, ...login });
      const home = shipHome(options.homes, shipId);
      const shipSockets = join(options.sockets, shipId);
      // The runtime mounts only a folder that exists, and the ship's socket may not have made it yet.
      await mkdir(shipSockets, { recursive: true, mode: 0o700 });
      await mkdir(home, { recursive: true, mode: 0o700 });
      await mkdir(files.folder, { recursive: true, mode: 0o700 });
      const envFile = join(files.folder, ENV_FILE);
      await writeFile(envFile, content, { mode: 0o600 });
      return {
        command: [
          options.binary,
          'run',
          '--rm',
          '-i',
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
          // A read-only workspace (aeolus-fleet#1449), whose files have no write bit, is mounted read-only, which the session cannot undo.
          (await isWritable(folder)) ? `${folder}:${folder}` : `${folder}:${folder}:ro`,
          '--volume',
          `${home}:${SESSION_HOME}`,
          // The session calls the fleet over its ship's socket, at the path its identity names.
          '--volume',
          `${shipSockets}:${shipSockets}`,
          // Its read-only checkouts (#1182), at their own paths as its identity names them: read-only in the mount, which the session cannot undo.
          ...readOnly.flatMap((path) => ['--volume', `${path}:${path}:ro`]),
          '--env',
          `HOME=${SESSION_HOME}`,
          ...(proxyToken === undefined ? [] : ['--env', proxyToken.variable, '--network', HOST_LOOPBACK_NETWORK]),
          '--workdir',
          folder,
          '--env-file',
          envFile,
          options.image,
          ...command,
        ],
        // The session's environment reaches the container through the env file alone.
        env: {},
      };
    },
  });

  return {
    ...holds,
    // The container's first process as the host sees it: every process of the session runs under it; none once it runs no more.
    sessionRootOf: async (shipId) => {
      const inspected = await runtime(['inspect', '--format', '{{.State.Pid}}', containerName(shipId)]);
      const pid = Number(inspected.stdout.trim());
      return inspected.status === 0 && Number.isInteger(pid) && pid > 1 ? pid : undefined;
    },
  };
}

/** The write bit its owner has on a folder, the session's user in the container; one that cannot be read is taken as writable, as before. */
const OWNER_WRITE = 0o200;

async function isWritable(folder: string): Promise<boolean> {
  const found = await stat(folder).catch(() => undefined);
  return found === undefined || (found.mode & OWNER_WRITE) !== 0;
}
