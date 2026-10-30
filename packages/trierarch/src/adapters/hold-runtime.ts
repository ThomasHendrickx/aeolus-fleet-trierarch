import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { uptime } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';

import { idSchema, type ShipId } from '@aeolus-fleet/common';

import type { ObservedSession, SessionRuntime } from '../core/ports.js';
import type { SessionRoots } from './caller-check.js';
import { INTERRUPT_WAIT_MS } from './hold.js';
import { callHold, holdFilesOf, type HoldFiles, type HoldRequest } from './hold-protocol.js';
import { writeProxyToken } from './proxy-tokens.js';

/** How long a hold has to answer a call other than interrupt. */
const CALL_TIMEOUT_MS = 2000;
/** How long a hold has to answer its first call after its start. */
const START_WAIT_MS = 10_000;
/** How often a starting hold is asked whether it answers. */
const START_POLL_MS = 50;
/** How long a stopped hold has to end with its harness before it is killed. */
const STOP_WAIT_MS = 5000;
/** How many of the last event lines are read: the launch window's error event is among the last. */
const EVENT_LINES = 200;
/** Runs the command in the background and returns at once: its process is then nobody's child, so no session runs under the trierarch's own process. */
const DETACHED = '"$@" < /dev/null > /dev/null 2>&1 &';

/** What a session runtime's start is given. */
export type SessionStart = Parameters<SessionRuntime['start']>[0];

/** What a hold runs for a session: the command, and the environment it is given on top of the hold's own few (H10). */
export interface HeldCommand {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** What a session's start goes through: a systemd scope of its own under a systemd unit, which sets INVOCATION_ID, so a restart or upgrade of the service ends no session (#479, #537). */
export function sessionsLaunch(at: { platform: string; env: Readonly<Record<string, string | undefined>> }): readonly string[] {
  return at.platform === 'linux' && at.env.INVOCATION_ID !== undefined ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--'] : [];
}

/**
 * The host session runtime (headless H4, H8, H9): one hold per ship, the
 * trierarch program run as `aeolus-trierarch hold`, which runs the harness as
 * its child and holds its input and output. Under a systemd unit a hold starts
 * in a scope of its own, so a restart or an upgrade of the service ends no
 * session (#479, #537). A hold is nobody's child: the fleet socket takes it
 * as its session's root (decision 0026), and a session's processes are never
 * under the trierarch's.
 *
 * A hold that answers runs; one that started since the machine did and no
 * longer answers has exited, kept so the exit is seen with its events; one
 * from before the machine started is gone. A hold another version started is
 * listed as such (H19). What runs beside the holds, as a container runtime's
 * containers, is stopped with its ship's hold, and listed as of another
 * version for a ship no hold holds: an older trierarch started it.
 *
 * A hold runs the session's command itself, unless the runtime holds it
 * otherwise: a container runtime's hold runs the runtime's run of it (H18).
 */
export function createHoldRuntime(options: {
  /** The sessions folder: a folder per ship, with its hold's files. */
  sessions: string;
  /** The trierarch program, which `hold` and its words follow. */
  program: readonly string[];
  version: string;
  platform: string;
  /** What a hold's start goes through: a systemd scope of its own under a systemd unit (see sessionsLaunch). */
  launch?: readonly string[];
  /** What runs beside the holds, one per ship: stopped first when its ship's hold stops, and listed as of another version for a ship no hold holds. */
  beside?: Pick<SessionRuntime, 'list' | 'stop'>;
  /** What the hold runs for a session, once the ship's last session is stopped and its folder is new; the session's command and environment unless given. */
  heldAs?: (session: SessionStart, files: HoldFiles) => Promise<HeldCommand>;
  /** When the machine started. */
  bootedAt?: () => Date;
}): SessionRuntime & SessionRoots {
  const { sessions, version } = options;
  const bootedAt = options.bootedAt ?? (() => new Date(Date.now() - uptime() * 1000));
  const filesOf = (shipId: ShipId) => holdFilesOf(sessions, shipId);

  /** The hold's pid, while its process runs. */
  const runningPid = async (shipId: ShipId): Promise<number | undefined> => {
    const pid = Number(await readFile(filesOf(shipId).pid, 'utf8').catch(() => ''));
    if (!Number.isInteger(pid) || pid <= 1) {
      return undefined;
    }
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return undefined;
    }
  };

  const observed = async (shipId: ShipId): Promise<ObservedSession | undefined> => {
    const files = filesOf(shipId);
    const started = await stat(files.pid).catch(() => undefined);
    if (started === undefined || started.mtime < bootedAt()) {
      return undefined;
    }
    const answer = await callHold({ socket: files.socket, request: { call: 'state' }, timeoutMs: CALL_TIMEOUT_MS }).catch(() => undefined);
    if (answer?.isOk !== true || answer.state === undefined) {
      return { shipId, status: 'exited' };
    }
    return { shipId, status: 'running', ...(answer.state.version !== version && { isOtherVersion: true }) };
  };

  const stop = async (shipId: ShipId): Promise<void> => {
    await options.beside?.stop(shipId);
    const pid = await runningPid(shipId);
    if (pid !== undefined) {
      process.kill(pid, 'SIGTERM');
      const until = Date.now() + STOP_WAIT_MS;
      while ((await runningPid(shipId)) !== undefined && Date.now() < until) {
        await wait(START_POLL_MS);
      }
      if ((await runningPid(shipId)) !== undefined) {
        process.kill(pid, 'SIGKILL');
      }
    }
    await rm(filesOf(shipId).folder, { recursive: true, force: true });
  };

  const must = async (shipId: ShipId, call: { request: HoldRequest; timeoutMs: number }): Promise<void> => {
    const { request } = call;
    const answer = await callHold({ socket: filesOf(shipId).socket, ...call });
    if (!answer.isOk) {
      throw new Error(`the hold of ${shipId} refused ${request.call}: ${answer.error}`);
    }
  };

  return {
    list: async () => {
      const folders = await readdir(sessions).catch(() => []);
      const shipIds = folders.flatMap((folder) => {
        const shipId = idSchema('ship').safeParse(folder);
        return shipId.success ? [shipId.data] : [];
      });
      const held = (await Promise.all(shipIds.map(observed))).flatMap((session) => (session === undefined ? [] : [session]));
      const heldIds = new Set(held.map((session) => session.shipId));
      const beside = ((await options.beside?.list()) ?? []).filter((session) => !heldIds.has(session.shipId)).map((session) => ({ ...session, isOtherVersion: true }));
      return [...held, ...beside];
    },
    stop,
    start: async (session) => {
      const { shipId, folder, harness, proxyToken } = session;
      await stop(shipId);
      const files = filesOf(shipId);
      // The token goes in the session's folder, which only its user reads, and the hold reads it there: a command line is anyone's to see.
      if (proxyToken !== undefined) {
        await mkdir(files.folder, { recursive: true, mode: 0o700 });
        await writeProxyToken(files.folder, proxyToken);
      }
      const tokenVariable = proxyToken === undefined ? [] : ['--proxy-token-variable', proxyToken.variable];
      const { command, env } = options.heldAs === undefined ? { command: session.command, env: session.env ?? {} } : await options.heldAs(session, files);
      const hold = [...options.program, 'hold', shipId, '--sessions', sessions, '--folder', folder, '--harness', harness, ...tokenVariable, ...Object.entries(env).flatMap(([variable, value]) => ['--env', `${variable}=${value}`]), '--', ...command];
      const [program = 'sh', ...args] = [...(options.launch ?? []), 'sh', '-c', DETACHED, 'sh', ...hold];
      const starter = spawn(program, args, { stdio: 'ignore', detached: true });
      await new Promise<void>((resolve, reject) => {
        starter.on('error', reject);
        starter.on('exit', () => {
          resolve();
        });
      });
      const until = Date.now() + START_WAIT_MS;
      while (Date.now() < until) {
        if ((await callHold({ socket: files.socket, request: { call: 'state' }, timeoutMs: CALL_TIMEOUT_MS }).catch(() => undefined))?.isOk === true) {
          return;
        }
        // A hold whose harness ended at once has ended too: its exit is seen in the next list.
        if ((await stat(files.pid).catch(() => undefined)) !== undefined && (await runningPid(shipId)) === undefined) {
          return;
        }
        await wait(START_POLL_MS);
      }
      throw new Error(`the hold of ${shipId} did not answer within ${String(START_WAIT_MS)} ms of its start`);
    },
    // A Codex hold starts the line's turn once the last turn's process has ended, which it waits for as long as for an interrupted turn.
    send: async ({ shipId, line }) => {
      await must(shipId, { request: { call: 'send', line }, timeoutMs: INTERRUPT_WAIT_MS + CALL_TIMEOUT_MS });
    },
    interrupt: async (shipId) => {
      await must(shipId, { request: { call: 'interrupt' }, timeoutMs: INTERRUPT_WAIT_MS + CALL_TIMEOUT_MS });
    },
    events: async (shipId) => {
      const text = await readFile(filesOf(shipId).events, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter((line) => line !== '')
        .slice(-EVENT_LINES);
    },
    sessionRootOf: runningPid,
  };
}
