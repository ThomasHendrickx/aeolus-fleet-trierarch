import { TrierarchFileError } from '../adapters/files.js';
import type { CommandResult } from '../adapters/run-command.js';
import type { Service } from '../adapters/service.js';

/**
 * `aeolus-trierarch upgrade [version]` (#255): installs the given version, or
 * the latest on npm, globally and pinned to it, then stops the old process and
 * starts the new one. Sessions are not touched: they run on the trierarch's
 * own tmux server, and the new process takes them over from its saved state.
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
  service: Pick<Service, 'stop' | 'start' | 'status'>;
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
    // Stop waits until the old process has exited, so only the new one ever runs the loop.
    await at.service.stop();
    await at.service.start();
    said.push(`The service runs ${to} now. Its sessions kept running: the new process takes them over.`);
  } else {
    said.push('The service is not installed: run aeolus-trierarch install to run it.');
  }
  return { from, to, isUpgraded: true, said };
}
