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
 * as every start waits (#466). Before the stop, the installed version writes
 * the service's file, as its own init does, and the supervisor reads it again,
 * so the stop already follows it (#485) and a change to the file arrives with
 * the version that makes it, not one upgrade later (#492).
 * It never upgrades on its own. A failed install leaves the old version
 * running. Where npm's global folder is not the user's to write, as under a
 * system Node install, it installs nothing and says what to run instead
 * (#480): it never runs sudo itself.
 */

export const PACKAGE = '@aeolus-fleet/trierarch';

/** npm, as upgrade needs it. */
export interface Npm {
  /** Where `npm install --global` puts packages, and whether the user may write there. */
  globalFolder(): Promise<{ path: string; isWritable: boolean }>;
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
  /** The installed version's `install --no-load`: this process still runs the code of the version it replaces. */
  writeInstalledServiceFile: () => Promise<CommandResult>;
  service: Pick<Service, 'reload' | 'stop' | 'start' | 'status'>;
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
  const folder = await at.npm.globalFolder();
  if (!folder.isWritable) {
    const instead = [`sudo npm install --global ${spec}`, ...((await at.service.status()).isInstalled ? ['aeolus-trierarch install'] : [])];
    throw new TrierarchFileError(
      `npm's global folder ${folder.path} is not yours to write: a system Node install owns it. Run instead:\n${instead.map((line) => `  ${line}`).join('\n')}\nThe trierarch keeps running ${from}.`,
    );
  }
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
        const written = await at.writeInstalledServiceFile();
        // aeolus-trierarch says a failure on stdout, node one it cannot run on stderr.
        if (written.status !== 0) {
          throw new TrierarchFileError(
            `The trierarch ${to} could not write the service's file: ${`${written.stdout}${written.stderr}`.trim()}\nThe service keeps running ${from}. Fix what it says, then run aeolus-trierarch install to write the file and restart the service.`,
          );
        }
        // Reloaded before the stop: on Linux the stop follows the reloaded unit, which ends the trierarch only (#479).
        await service.reload();
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
