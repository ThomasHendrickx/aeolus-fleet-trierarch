import { setTimeout as wait } from 'node:timers/promises';

import { loadConfiguration, readCrewFile } from '../adapters/files.js';
import { createGitWorkspace } from '../adapters/git-workspace.js';
import { createHarnesses } from '../adapters/harnesses.js';
import { createJsonState } from '../adapters/json-state.js';
import type { TrierarchPaths } from '../adapters/paths.js';
import { createRestFleet } from '../adapters/rest-fleet.js';
import { createTmux } from '../adapters/tmux.js';
import { runningVersion } from '../adapters/version.js';
import { createHandleDelivery } from '../core/handle-delivery.js';
import type { Delivery, Logger } from '../core/ports.js';
import { createRunPass } from '../core/run-pass.js';

/** How often the loop runs a pass: restarts, wakes and releases wait at most this long. */
export const PASS_INTERVAL_MS = 5000;

/**
 * `aeolus-trierarch run`: the loop. It receives what comes to the trierarch's
 * ship and handles each command, and runs a pass every few seconds, one thing
 * at a time, until it is told to stop. A failure is logged and the loop goes
 * on: the next pass starts from the saved state.
 */
export async function runTrierarch(input: { paths: TrierarchPaths; homeDirectory: string; env: Readonly<Record<string, string | undefined>>; signal: AbortSignal; logger: Logger & { info(message: string): void } }): Promise<void> {
  const { paths, homeDirectory, env, signal, logger } = input;
  const configuration = await loadConfiguration(paths.config);
  const crew = await readCrewFile(paths.crewToken);
  const fleet = createRestFleet(crew);
  const tmux = createTmux();
  const { harnesses, plugins } = await createHarnesses({ configuration, homeDirectory, env, sessions: tmux });
  const workspace = createGitWorkspace({ configuration, root: configuration.worktreeRoot ?? paths.worktrees });
  const state = createJsonState(paths.state);
  const clock = { now: () => new Date() };
  const setup = { configuration, version: runningVersion() };
  const handle = createHandleDelivery({ fleet, workspace, state, setup, clock, logger });
  const pass = createRunPass({ fleet, harnesses, processes: tmux, workspace, state, setup, clock, logger });

  const found = Object.entries(plugins).map(([harness, plugin]) => `${harness} at ${plugin.root}`);
  logger.info(`aeolus-trierarch ${setup.version} runs for ${crew.fleetUrl}, with the aeolus plugin for ${found.join(' and ') || 'no harness'}`);
  await loop({ receive: (stop) => fleet.receive(stop), handle, pass, signal, logger, intervalMs: PASS_INTERVAL_MS });
}

/**
 * Receives and handles what came, and runs a pass at most every `intervalMs`,
 * until `signal` stops it. The stop ends a receive the fleet still holds, and
 * the wait after a failure, at once: a service manager that stops the
 * trierarch sees it gone in a moment, not after the next long poll.
 */
export async function loop(at: {
  receive: (signal: AbortSignal) => Promise<readonly Delivery[]>;
  handle: (delivery: Delivery) => Promise<void>;
  pass: () => Promise<void>;
  signal: AbortSignal;
  logger: Logger;
  intervalMs: number;
}): Promise<void> {
  const { signal, logger, intervalMs } = at;
  // Asked afresh each time: a stop comes from outside while the loop waits.
  const isStopped = (): boolean => signal.aborted;
  let lastPass = 0;
  while (!isStopped()) {
    try {
      for (const delivery of await at.receive(signal)) {
        await at.handle(delivery);
      }
      if (Date.now() - lastPass >= intervalMs) {
        lastPass = Date.now();
        await at.pass();
      }
    } catch (error) {
      if (isStopped()) {
        return;
      }
      logger.warn(`The loop failed and goes on: ${error instanceof Error ? error.message : String(error)}`);
      await wait(intervalMs, undefined, { signal }).catch(() => undefined);
    }
  }
}
