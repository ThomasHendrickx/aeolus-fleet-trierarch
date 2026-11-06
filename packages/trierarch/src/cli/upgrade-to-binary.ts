import { dirname } from 'node:path';

import type { BinaryFile } from '../adapters/binary-file.js';
import { TrierarchFileError, type RunningFile } from '../adapters/files.js';
import type { CommandResult } from '../adapters/run-command.js';
import type { Service } from '../adapters/service.js';
import { startNewProcess } from './new-process.js';
import { pluginStepOf } from './plugin-step.js';
import type { UpgradeReport } from './upgrade.js';

/**
 * Today's trierarch moves to the Go trierarch by one upgrade (#142,
 * docs/design/trierarch-binary.md, "The order of the move"): when the release
 * of the version carries a binary for this system and chip, checked against
 * SHA256SUMS and its attestation, upgrade takes it instead of npm. The binary
 * is staged beside ~/.local/bin/aeolus-trierarch and must say its version and
 * accept the configuration before it takes the place. Then its own upgrade at
 * its version runs its plugin step, rewrites the service file to name it and
 * restarts the service on it, which takes the sessions' holds over as another
 * version's. When the service then does not run it, the file goes back as it
 * was, and this trierarch writes its own service file again and restarts on
 * itself: a failure leaves today's trierarch running.
 */

export type { BinaryFile } from '../adapters/binary-file.js';

/** The GitHub Release route of upgrade. */
export interface BinaryRoute {
  /** The version of the latest release; none when there is none, or GitHub does not answer it. */
  latest(): Promise<string | undefined>;
  /** The release's binary of the version for this system and chip, once its checksum and attestation hold; none when the release carries none. Refuses with a TrierarchFileError otherwise. */
  release(version: string): Promise<Buffer | undefined>;
  /** Where the binary of the version goes. */
  file(version: string): BinaryFile;
  /** Runs a trierarch file with the words, the configuration's path added where the command takes it. */
  run(program: string, words: readonly string[]): Promise<CommandResult>;
}

/** What a trierarch said, its error alone when it answered one as JSON. */
function reasonOf(answer: CommandResult): string {
  const output = `${answer.stdout}${answer.stderr}`.trim();
  try {
    const parsed: unknown = JSON.parse(answer.stdout);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    // Not JSON: what it said as it is.
  }
  return output;
}

/** The version a trierarch says it runs, none when it answers none. */
function versionOf(answer: CommandResult): string | undefined {
  try {
    const parsed: unknown = JSON.parse(answer.stdout);
    return answer.status === 0 && typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export async function upgradeToBinary(at: {
  from: string;
  to: string;
  binary: Buffer;
  route: BinaryRoute;
  service: Pick<Service, 'rewrite' | 'reload' | 'stop' | 'start' | 'status'>;
  /** What running.json says now: the service's process writes it as it starts. */
  running: () => Promise<RunningFile | undefined>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<UpgradeReport> {
  const { from, to, route, service } = at;
  const keeps = `The trierarch keeps running ${from}.`;
  const file = route.file(to);
  const staged = await file.stage(at.binary);
  try {
    const answered = await route.run(staged, ['--version', '--json']);
    const version = versionOf(answered);
    if (version !== to) {
      throw new TrierarchFileError(`The trierarch ${to} does not run here: ${version === undefined ? reasonOf(answered) : `it says it runs ${version}`}\n${keeps}`);
    }
    // The service restarts on the binary only when it accepts the configuration: one that does not would crash-loop, and the fleet lose the trierarch with its sessions.
    const isServiceInstalled = (await service.status()).isInstalled;
    if (isServiceInstalled) {
      const checked = await route.run(staged, ['config', 'check', '--json']);
      if (checked.status !== 0) {
        throw new TrierarchFileError(
          `The trierarch ${to} does not accept the configuration: ${reasonOf(checked)}\nIt stays on ${from}, running; the plugin and the service are untouched. Fix the configuration, then run aeolus-trierarch upgrade again.`,
        );
      }
    }
    await file.place();
    // The binary runs its own upgrade at its version: its plugin step, its service file, and the restart on it.
    const plugin = pluginStepOf(await route.run(file.path, ['upgrade', to, '--json']), to);
    const said = [`Upgraded the trierarch from ${from} to ${to}, the binary ${file.path}.`, ...plugin.said];
    if (!isServiceInstalled) {
      said.push(`The service is not installed: run ${file.path} init to run it.`);
    } else if (!(await runs(at, to))) {
      await putBack(at, file);
    }
    said.push(`The trierarch is the binary ${file.path} now: put ${dirname(file.path)} on PATH if it is not, then remove the npm package with npm uninstall --global @aeolus-fleet/trierarch.`);
    return { from, to, isUpgraded: true, isPluginUpdated: plugin.isPluginUpdated, said };
  } finally {
    await file.settle();
  }
}

/** Whether the service's process is the trierarch of the version, as running.json says it. */
async function runs(at: { service: Pick<Service, 'status'>; running: () => Promise<RunningFile | undefined> }, version: string): Promise<boolean> {
  const [status, running] = await Promise.all([at.service.status(), at.running()]);
  return status.isRunning && running !== undefined && running.pid === status.pid && running.version === version;
}

/** Puts the file back as it was, and restarts the service on this trierarch, its own service file written again; refuses with what happened. */
async function putBack(at: Parameters<typeof upgradeToBinary>[0], file: BinaryFile): Promise<never> {
  const { from, to, service } = at;
  const failed = `The trierarch ${to} did not start: it did not say its version (aeolus-trierarch logs says why).`;
  await file.putBack();
  const { hasSaidVersion } = await startNewProcess({
    start: async () => {
      await service.rewrite();
      // Reloaded before the stop: on Linux the stop follows the reloaded unit, which ends the trierarch only (#479).
      await service.reload();
      await service.stop();
      await service.start();
    },
    service,
    running: at.running,
    ...(at.sleep !== undefined && { sleep: at.sleep }),
  });
  if (!hasSaidVersion) {
    throw new TrierarchFileError(`${failed}\nThe trierarch ${from} is back; the service restarted on it, which has not said its version yet either.`);
  }
  throw new TrierarchFileError(`${failed}\nThe trierarch ${from} runs again; the aeolus-fleet plugin stays on ${to}'s: run aeolus-trierarch upgrade ${from} to put it back too.`);
}
