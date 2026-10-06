import { createClaudeCodeHarness } from '../adapters/claude-code.js';
import { loadConfiguration, readCrewFile } from '../adapters/files.js';
import { createGitWorkspace } from '../adapters/git-workspace.js';
import { createJsonState } from '../adapters/json-state.js';
import type { TrierarchPaths } from '../adapters/paths.js';
import { findAeolusPlugin } from '../adapters/plugin.js';
import { createRestFleet } from '../adapters/rest-fleet.js';
import { createTmux } from '../adapters/tmux.js';
import { runningVersion } from '../adapters/version.js';
import { createHandleDelivery } from '../core/handle-delivery.js';
import type { Logger } from '../core/ports.js';
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
  const plugin = await findAeolusPlugin({ homeDirectory, env });
  const fleet = createRestFleet(crew);
  const tmux = createTmux();
  const harness = createClaudeCodeHarness({ configuration, plugin, sessions: tmux });
  const workspace = createGitWorkspace({ configuration, root: configuration.worktreeRoot ?? paths.worktrees });
  const state = createJsonState(paths.state);
  const clock = { now: () => new Date() };
  const setup = { configuration, version: runningVersion() };
  const handle = createHandleDelivery({ fleet, workspace, state, setup, clock, logger });
  const pass = createRunPass({ fleet, harness, processes: tmux, workspace, state, setup, clock, logger });

  logger.info(`aeolus-trierarch ${setup.version} runs for ${crew.fleetUrl}, with the aeolus plugin at ${plugin.root}`);
  let lastPass = 0;
  while (!signal.aborted) {
    try {
      for (const delivery of await fleet.receive()) {
        await handle(delivery);
      }
      if (Date.now() - lastPass >= PASS_INTERVAL_MS) {
        lastPass = Date.now();
        await pass();
      }
    } catch (error) {
      logger.warn(`The loop failed and goes on: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, PASS_INTERVAL_MS));
    }
  }
}
