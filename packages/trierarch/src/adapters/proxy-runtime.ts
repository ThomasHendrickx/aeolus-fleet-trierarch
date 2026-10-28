import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { z } from 'zod';

import { STATE_PATH } from './model-proxy.js';

/**
 * Keeps the model proxy running while a harness needs it (headless H16): one
 * per machine, started like a hold, nobody's child and under a systemd unit
 * in a scope of its own, so a restart of the service ends no session's way to
 * its vendor. A proxy that is gone is started again on its port; one another
 * version started is replaced; one no harness needs is stopped.
 */

export interface ProxyRuntime {
  keep(at: { isNeeded: boolean }): Promise<void>;
  /** Where sessions reach the proxy; none before it first listened. */
  url(): Promise<string | undefined>;
}

export interface ProxyFiles {
  readonly pid: string;
  readonly port: string;
}

export function proxyFilesOf(folder: string): ProxyFiles {
  return { pid: join(folder, 'proxy.pid'), port: join(folder, 'port') };
}

const STATE_TIMEOUT_MS = 2000;
const START_WAIT_MS = 10_000;
const POLL_MS = 50;
const STOP_WAIT_MS = 5000;
/** Runs the command in the background and returns at once, as a hold's start does. */
const DETACHED = '"$@" < /dev/null > /dev/null 2>&1 &';

const stateSchema = z.object({ version: z.string() });

export function createProxyRuntime(options: {
  folder: string;
  sessions: string;
  keys: string;
  /** The trierarch program, which `proxy` and its words follow. */
  program: readonly string[];
  version: string;
  /** What the proxy's start goes through: a systemd scope of its own under a systemd unit (see sessionsLaunch). */
  launch?: readonly string[];
}): ProxyRuntime {
  const files = proxyFilesOf(options.folder);

  const url = async (): Promise<string | undefined> => {
    const port = Number(await readFile(files.port, 'utf8').catch(() => ''));
    return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${String(port)}` : undefined;
  };

  /** The version the proxy at its address answers; none when nothing answers. */
  const answeredVersion = async (): Promise<string | undefined> => {
    const at = await url();
    if (at === undefined) {
      return undefined;
    }
    const answer = await fetch(`${at}${STATE_PATH}`, { signal: AbortSignal.timeout(STATE_TIMEOUT_MS) }).catch(() => undefined);
    const state = stateSchema.safeParse(answer?.ok === true ? await answer.json().catch(() => undefined) : undefined);
    return state.success ? state.data.version : undefined;
  };

  const runningPid = async (): Promise<number | undefined> => {
    const pid = Number(await readFile(files.pid, 'utf8').catch(() => ''));
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

  const stop = async (): Promise<void> => {
    const pid = await runningPid();
    if (pid !== undefined) {
      process.kill(pid, 'SIGTERM');
      const until = Date.now() + STOP_WAIT_MS;
      while ((await runningPid()) !== undefined && Date.now() < until) {
        await wait(POLL_MS);
      }
      if ((await runningPid()) !== undefined) {
        process.kill(pid, 'SIGKILL');
      }
    }
    await rm(files.pid, { force: true });
  };

  const start = async (): Promise<void> => {
    const proxy = [...options.program, 'proxy', '--folder', options.folder, '--sessions', options.sessions, '--keys', options.keys];
    const [program = 'sh', ...args] = [...(options.launch ?? []), 'sh', '-c', DETACHED, 'sh', ...proxy];
    const starter = spawn(program, args, { stdio: 'ignore', detached: true });
    await new Promise<void>((resolve, reject) => {
      starter.on('error', reject);
      starter.on('exit', () => {
        resolve();
      });
    });
    const until = Date.now() + START_WAIT_MS;
    while (Date.now() < until) {
      if ((await runningPid()) !== undefined && (await answeredVersion()) !== undefined) {
        return;
      }
      await wait(POLL_MS);
    }
    throw new Error(`the model proxy did not answer within ${String(START_WAIT_MS)} ms of its start`);
  };

  return {
    keep: async ({ isNeeded }) => {
      if (!isNeeded) {
        await stop();
        return;
      }
      const version = await answeredVersion();
      if (version === options.version) {
        return;
      }
      // Its pid file goes before the start, so the wait sees the new proxy's.
      await stop();
      await start();
    },
    url,
  };
}
