import { TrierarchFileError, type RunningFile } from '../adapters/files.js';
import type { CommandResult } from '../adapters/run-command.js';
import type { Service } from '../adapters/service.js';
import { NOT_SAID_YET_REASON, startNewProcess } from './new-process.js';

/**
 * `aeolus-trierarch upgrade [version]` (#255): installs the given version, or
 * the latest on npm, globally and pinned to it, then stops the old process and
 * starts the new one. Sessions are not touched: they run on the trierarch's
 * own tmux server, and the new process takes them over from its saved state.
 * It reports once the new process has said its version in running.json, so
 * the status that follows shows it running (#376), waiting at most 30 seconds,
 * as every start waits (#466). It rewrites the service's file first, as init
 * does, so the stop already follows the file this version writes (#485).
 * It never upgrades on its own. A failed install leaves the old version
 * running.
 */

export const PACKAGE = '@aeolus-fleet/trierarch';

/** npm, as upgrade needs it. */
export interface Npm {
  /** The latest version on npm. */
  latest(): Promise<string>;
  /** `npm install --global <spec>`. */
  install(spec: string): Promise<CommandResult>;
}

export interface UpgradeReport {
  readonly from: string;
  readonly to: string;
  readonly isUpgraded: boolean;
  readonly said: readonly string[];
}

const VERSION = /^\d+\.\d+\.\d+$/;

export async function upgradeTrierarch(at: {
  version?: string;
  /** The version installed now, read afresh each time: the install replaces it. */
  installedVersion: () => string;
  npm: Npm;
  service: Pick<Service, 'rewrite' | 'stop' | 'start' | 'status'>;
  /** What running.json says now: the new process writes it as it starts. */
  running: () => Promise<RunningFile | undefined>;
  /** Waits between reads of running.json; a test passes one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<UpgradeReport> {
  const from = at.installedVersion();
  if (at.version !== undefined && !VERSION.test(at.version)) {
    throw new TrierarchFileError(`${at.version} is no version: give one such as 0.17.2`);
  }
  const target = at.version ?? (await at.npm.latest()).trim();
  if (target === from) {
    return { from, to: from, isUpgraded: false, said: [`The trierarch is already on ${from}.`] };
  }

  const spec = `${PACKAGE}@${target}`;
  const installed = await at.npm.install(spec);
  if (installed.status !== 0) {
    throw new TrierarchFileError(
      `npm install --global ${spec} failed: ${installed.stderr.trim()}\nThe trierarch keeps running ${from}. Fix what npm says, then run aeolus-trierarch upgrade again.`,
    );
  }
  const to = at.installedVersion();
  const said = [`Upgraded the trierarch from ${from} to ${to}.`];

  if ((await at.service.status()).isInstalled) {
    const { service } = at;
    const { hasSaidVersion } = await startNewProcess({
      start: async () => {
        // Rewritten before the stop: on Linux the stop follows the reloaded unit, which ends the trierarch only (#479).
        await service.rewrite();
        // Stop waits until the old process has exited, so only the new one ever runs the loop.
        await service.stop();
        await service.start();
      },
      service,
      running: at.running,
      ...(at.sleep !== undefined && { sleep: at.sleep }),
    });
    said.push(
      hasSaidVersion
        ? `The service runs ${to} now. Its sessions kept running: the new process takes them over.`
        : `The service started ${to}, but ${NOT_SAID_YET_REASON}`,
    );
  } else {
    said.push('The service is not installed: run aeolus-trierarch install to run it.');
  }
  return { from, to, isUpgraded: true, said };
}
