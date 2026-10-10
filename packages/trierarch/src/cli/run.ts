import { setTimeout as wait } from 'node:timers/promises';

import { loadConfiguration, readCrewFile, writeRunningFile } from '../adapters/files.js';
import { createDetectedFile } from '../adapters/detected-file.js';
import { createDetectors } from '../adapters/detectors.js';
import { createGitWorkspace } from '../adapters/git-workspace.js';
import { adapterFlagsOf, createHarnesses, riskyFlagsOf } from '../adapters/harnesses.js';
import { createJsonState } from '../adapters/json-state.js';
import type { TrierarchPaths } from '../adapters/paths.js';
import { createRestFleet } from '../adapters/rest-fleet.js';
import { createTmux } from '../adapters/tmux.js';
import { createTrust } from '../adapters/trust.js';
import { runningVersion } from '../adapters/version.js';
import { createDetectHarnesses } from '../core/detect-harnesses.js';
import { modelOptionsIgnored, withDetectedOptions } from '../core/detected-options.js';
import { createRefuseModel } from '../core/refuse-model.js';
import { createReportDetectionProblems } from '../core/report-detection-problems.js';
import { createHandleDelivery } from '../core/handle-delivery.js';
import { machineOf } from '../core/machine.js';
import type { Delivery, Logger, TrierarchSetup } from '../core/ports.js';
import { createReportSelf } from '../core/report-self.js';
import { createRunPass } from '../core/run-pass.js';

/** How often the loop runs a pass: restarts, wakes and releases wait at most this long. */
export const PASS_INTERVAL_MS = 5000;

/**
 * `aeolus-trierarch run`: the loop. It receives what comes to the trierarch's
 * ship and handles each delivery, and runs a pass every few seconds beside it,
 * until it is told to stop. A failure is logged and the loop goes on: the next
 * pass starts from the saved state.
 */
export async function runTrierarch(input: { paths: TrierarchPaths; homeDirectory: string; env: Readonly<Record<string, string | undefined>>; managedSettings: string; signal: AbortSignal; logger: Logger & { info(message: string): void } }): Promise<void> {
  const { paths, homeDirectory, env, managedSettings, signal, logger } = input;
  const configured = await loadConfiguration(paths.config);
  const crew = await readCrewFile(paths.crewToken);
  const fleet = createRestFleet(crew);
  // Detected again only for a harness whose version changed since (#365); the operator's own options win.
  const detectedStore = createDetectedFile(paths.detected);
  const detectHarnesses = createDetectHarnesses({ detectors: createDetectors({ homeDirectory, env }), store: detectedStore, clock: { now: () => new Date() }, logger });
  const detected = await detectHarnesses({ harnesses: Object.keys(configured.harnesses), by: 'start' });
  await createReportDetectionProblems({ fleet })(detected).catch((error: unknown) => {
    logger.warn(`Could not tell argo what detection found: ${error instanceof Error ? error.message : String(error)}`);
  });
  for (const harness of modelOptionsIgnored(configured)) {
    logger.warn(`${harness}: the configuration's model option is ignored: model ids come from detection only (#382); remove it`);
  }
  const configuration = withDetectedOptions(configured, detected);
  // What the machine offers changes while it runs, as sessions refuse models (#382): each pass and report reads it afresh.
  let offered = { configuration, detected };
  const tmux = createTmux();
  const { harnesses, plugins } = await createHarnesses({ configuration, homeDirectory, env, managedSettings, detected: () => offered.detected, sessions: tmux });
  const workspace = createGitWorkspace({ configuration, root: configuration.worktreeRoot ?? paths.worktrees });
  const state = createJsonState(paths.state);
  const trust = createTrust({ configuration, homeDirectory, env, managedSettings });
  const clock = { now: () => new Date() };
  const setup: TrierarchSetup = {
    get configuration() {
      return offered.configuration;
    },
    version: runningVersion(),
    adapterFlags: adapterFlagsOf(configuration),
    riskyFlags: riskyFlagsOf(configuration),
    machine: machineOf({ platform: process.platform, arch: process.arch }),
    get detected() {
      return offered.detected;
    },
  };
  const refuseModel = createRefuseModel({
    store: detectedStore,
    detect: detectHarnesses,
    onDetected: (found) => {
      const kept = Object.fromEntries(Object.entries(found).filter(([harness]) => harness in configured.harnesses));
      offered = { configuration: withDetectedOptions(configured, kept), detected: kept };
    },
    logger,
  });
  const handle = createHandleDelivery({ fleet, logger });
  const runPass = createRunPass({ fleet, harnesses, processes: tmux, workspace, trust, state, setup, clock, logger, refuseModel });
  const reportSelf = createReportSelf({ fleet, processes: tmux, trust, state, setup });
  // Each pass ends with the trierarch's own report: the first at start, then only when it changed.
  const pass = async (): Promise<void> => {
    await runPass();
    await reportSelf();
  };

  await writeRunningFile(paths.running, { pid: process.pid, version: setup.version });
  const found = Object.entries(plugins).map(([harness, plugin]) => `${harness} at ${plugin.root}`);
  logger.info(`aeolus-trierarch ${setup.version} runs for ${crew.fleetUrl}, with the aeolus plugin for ${found.join(' and ') || 'no harness'}`);
  await loop({ receive: (stop) => fleet.receive(stop), handle, pass, signal, logger, intervalMs: PASS_INTERVAL_MS });
}

/**
 * Receives and handles what came, and runs a pass every `intervalMs`, until
 * `signal` stops it. The two run side by side: a receive the fleet holds for
 * its long poll never delays a pass, so restarts and wakes act within the
 * interval (#250). Handling a delivery touches no state (a ping gets pong,
 * anything else is acknowledged), so the two never contend. A failure is
 * logged and its side waits an interval before it goes on. The stop ends a
 * receive the fleet still holds, and every wait, at once: a service manager
 * that stops the trierarch sees it gone in a moment, not after the next long
 * poll.
 */
export async function loop(at: {
  receive: (signal: AbortSignal) => Promise<readonly Delivery[]>;
  handle: (delivery: Delivery) => Promise<void>;
  pass: () => Promise<void>;
  signal: AbortSignal;
  logger: Pick<Logger, 'warn'>;
  intervalMs: number;
}): Promise<void> {
  const { signal, logger, intervalMs } = at;
  // Asked afresh each time: a stop comes from outside while the loop waits.
  const isStopped = (): boolean => signal.aborted;
  const pause = () => wait(intervalMs, undefined, { signal }).catch(() => undefined);
  /** Runs one step after another until the stop, logging a failure and pausing after it; a paced one waits an interval after each. */
  const repeat = async (step: () => Promise<void>, pacing: { isPaced: boolean }): Promise<void> => {
    while (!isStopped()) {
      try {
        await step();
        if (pacing.isPaced) {
          await pause();
        }
      } catch (error) {
        if (isStopped()) {
          return;
        }
        logger.warn(`The loop failed and goes on: ${error instanceof Error ? error.message : String(error)}`);
        await pause();
      }
    }
  };
  await Promise.all([
    repeat(
      async () => {
        for (const delivery of await at.receive(signal)) {
          await at.handle(delivery);
        }
      },
      { isPaced: false },
    ),
    repeat(at.pass, { isPaced: true }),
  ]);
}
