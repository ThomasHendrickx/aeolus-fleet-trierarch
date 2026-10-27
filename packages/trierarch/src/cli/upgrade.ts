import { z } from 'zod';

import { TrierarchFileError, type RunningFile } from '../adapters/files.js';
import { byVersion, type PluginHarness } from '../adapters/plugin.js';
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
 * (#480): it never runs sudo itself. What it says to run then includes
 * upgrade again at the new version, which updates the plugin (#718).
 * It updates the aeolus-fleet plugin too, for each harness the configuration
 * offers, also when the trierarch is on the version already: on a trierarch
 * machine the plugin is updated this way only (#581). Codex's version folders
 * running sessions use stay, those none uses go (#653), and the plugin's new
 * or changed Codex hooks are trusted, so a new session starts without a
 * prompt. After an install, the installed version runs that step, as its
 * own upgrade at its version, so one upgrade always ends with the plugin
 * step of the version it upgrades to (#725). The update comes before
 * the restart, so the new process starts with it. A failed plugin update is
 * said, and the upgrade goes on. The plugin comes from the release tag of the
 * version it upgrades to, from main for releases up to 0.22.0, whose tags
 * hold no plugin of their version (#652). A Codex downgrade keeps the newer
 * version folder for the sessions running on it, so new Codex sessions start
 * on it too: upgrade says so. Its version's step takes `--remote-control` out
 * of the configuration, saying so, as no session has Remote Control from
 * 0.33.0 and the trierarch refuses to start with it (headless H20). On the
 * version already, it restarts the
 * service when the service runs another version, as after an install by hand
 * (#829), unless it runs as the plugin step of an upgrade, which restarts the
 * service itself.
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

/** The aeolus-fleet plugin, as upgrade updates it. */
export interface PluginUpgrade {
  /** The harnesses the configuration offers. */
  readonly harnesses: readonly PluginHarness[];
  /** `tag`: the release tag to install the plugin from; none installs it from main. */
  update(harness: PluginHarness, tag: string | undefined): Promise<void>;
  /** The plugin's version as the harness reads it; none when it has no aeolus-fleet plugin. */
  version(harness: PluginHarness): Promise<string | undefined>;
  /** Trusts the plugin's new or changed Codex hooks: their keys. */
  trustCodexHooks(): Promise<readonly string[]>;
}

export interface UpgradeReport {
  readonly from: string;
  readonly to: string;
  readonly isUpgraded: boolean;
  /** False when the aeolus-fleet plugin could not be updated, or its Codex hooks not trusted, for a harness on offer. */
  readonly isPluginUpdated: boolean;
  readonly said: readonly string[];
}

const HARNESS_NAMES: Record<PluginHarness, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first release whose tag holds the aeolus-fleet plugin of its version (#652): the ones before set the plugin's version on main only. */
const FIRST_PLUGIN_TAG = '0.23.0';

/** Updates the aeolus-fleet plugin of `version` for each harness on offer, each on its own: one that fails leaves the others to update. */
async function upgradePlugin(plugin: PluginUpgrade | undefined, version: string): Promise<{ isPluginUpdated: boolean; said: string[] }> {
  const said: string[] = [];
  let isPluginUpdated = true;
  if (plugin === undefined || plugin.harnesses.length === 0) {
    return { isPluginUpdated, said };
  }
  const tag = byVersion(version, FIRST_PLUGIN_TAG) >= 0 ? `v${version}` : undefined;
  if (tag === undefined) {
    said.push(`Releases up to 0.22.0 tag no aeolus-fleet plugin of their version: the plugin comes from main, the latest released one.`);
  }
  for (const harness of plugin.harnesses) {
    const name = HARNESS_NAMES[harness];
    const before = await plugin.version(harness);
    try {
      await plugin.update(harness, tag);
    } catch (error) {
      isPluginUpdated = false;
      said.push(`The aeolus-fleet plugin for ${name} was not updated: ${reasonOf(error)}. It stays on ${before ?? 'no version'}; fix what it says, then run aeolus-trierarch upgrade again.`);
      continue;
    }
    const after = await plugin.version(harness);
    const keeps = harness === 'codex' ? ' Running Codex sessions keep the version they started with.' : '';
    said.push(after === before ? `The aeolus-fleet plugin for ${name} is on ${after ?? 'no version'} already.` : `Updated the aeolus-fleet plugin for ${name} from ${before ?? 'no version'} to ${after ?? 'no version'}.${keeps}`);
    // Codex starts on its newest version folder, and upgrade keeps a newer one for the sessions running on it (#652).
    if (harness === 'codex' && tag !== undefined && after !== undefined && byVersion(after, version) > 0) {
      said.push(`New Codex sessions keep starting on the aeolus-fleet plugin ${after}, not on ${version}: Codex starts on the newest version it has, and ${after} stays for the Codex sessions running on it.`);
    }
    if (harness === 'codex') {
      try {
        const trusted = await plugin.trustCodexHooks();
        if (trusted.length > 0) {
          said.push(`Codex trusts the aeolus-fleet plugin's ${String(trusted.length)} new or changed hooks.`);
        }
      } catch (error) {
        isPluginUpdated = false;
        said.push(`Codex does not trust the aeolus-fleet plugin's hooks yet: ${reasonOf(error)}. Each Codex launch trusts them first, and starts no session while they cannot be; fix what it says, then run aeolus-trierarch upgrade again.`);
      }
    }
  }
  return { isPluginUpdated, said };
}

const VERSION = /^\d+\.\d+\.\d+$/;

/** What an upgrade says when it took Remote Control out of the configuration (headless H20). */
function remoteControlRemoved(harnesses: readonly string[]): string {
  return `Took --remote-control out of the flags of ${harnesses.join(', ')} in the configuration: a session the trierarch runs has no terminal, so no Remote Control.`;
}

function alreadyOn(version: string): string {
  return `The trierarch is already on ${version}.`;
}

/** What the installed version's `upgrade --json` says that the plugin step needs. */
const installedReportSchema = z.object({ isPluginUpdated: z.boolean(), said: z.array(z.string()) });

/** The plugin step as the installed version ran it, from what its upgrade at its own version answered. */
function pluginStepOf(answer: CommandResult, version: string): { isPluginUpdated: boolean; said: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(answer.stdout);
  } catch {
    raw = undefined;
  }
  const parsed = installedReportSchema.safeParse(raw);
  if (!parsed.success) {
    const output = `${answer.stdout}${answer.stderr}`.trim();
    return { isPluginUpdated: false, said: [`The aeolus-fleet plugin was not updated: the trierarch ${version} said ${output}. Fix what it says, then run aeolus-trierarch upgrade again.`] };
  }
  return { isPluginUpdated: parsed.data.isPluginUpdated, said: parsed.data.said.filter((line) => line !== alreadyOn(version)) };
}

/** What restarting the service on the installed version needs. */
interface Restart {
  /** The installed version's `install --no-load`: this process still runs the code of the version it replaces. */
  writeInstalledServiceFile: () => Promise<CommandResult>;
  service: Pick<Service, 'reload' | 'stop' | 'start' | 'status'>;
  /** What running.json says now: the new process writes it as it starts. */
  running: () => Promise<RunningFile | undefined>;
  /** Waits between reads of running.json; a test passes one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Restarts the service on the installed version `to`, the old process on
 * `from` stopped first, and says what runs once the new process said its
 * version. Before the stop, the installed version writes the service's file
 * and the supervisor reads it again (#485, #492).
 */
async function restartOn(at: Restart, versions: { from: string; to: string }): Promise<string> {
  const { service } = at;
  const { from, to } = versions;
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
  return hasSaidVersion ? `The service runs ${to} now. Its sessions kept running: the new process takes them over.` : `The service started ${to}, but ${NOT_SAID_YET_REASON}`;
}

/** The version the service runs, when it runs one other than `installed`. */
async function otherRunningVersion(at: Restart, installed: string): Promise<string | undefined> {
  const [status, running] = await Promise.all([at.service.status(), at.running()]);
  return status.isRunning && running !== undefined && running.version !== installed ? running.version : undefined;
}

export async function upgradeTrierarch(at: Restart & {
  version?: string;
  /** Runs as the plugin step of an upgrade of another process (#725), which restarts the service itself. */
  isPluginStepOfAnUpgrade?: boolean;
  /** The version installed now, read afresh each time: the install replaces it. */
  installedVersion: () => string;
  npm: Npm;
  /** The installed version's `upgrade <version> --json`: on its version already, it runs the plugin step as that version runs it. */
  upgradeInstalledPlugin: (version: string) => Promise<CommandResult>;
  /** The aeolus-fleet plugin; none updates nothing. */
  plugin?: PluginUpgrade;
  /** Takes Remote Control out of the configuration (headless H20): the harnesses whose flags carried it. */
  removeRemoteControl: () => Promise<readonly string[]>;
}): Promise<UpgradeReport> {
  const from = at.installedVersion();
  if (at.version !== undefined && !VERSION.test(at.version)) {
    throw new TrierarchFileError(`${at.version} is no version: give one such as 0.17.2`);
  }
  const target = at.version ?? (await at.npm.latest()).trim();
  if (target === from) {
    const removed = await at.removeRemoteControl();
    const plugin = await upgradePlugin(at.plugin, target);
    const said = [alreadyOn(from), ...(removed.length === 0 ? [] : [remoteControlRemoved(removed)]), ...plugin.said];
    const running = at.isPluginStepOfAnUpgrade === true ? undefined : await otherRunningVersion(at, from);
    if (running !== undefined) {
      said.push(`The service ran ${running}, so it restarted on ${from}.`, await restartOn(at, { from: running, to: from }));
    }
    return { from, to: from, isUpgraded: false, isPluginUpdated: plugin.isPluginUpdated, said };
  }

  const spec = `${PACKAGE}@${target}`;
  const folder = await at.npm.globalFolder();
  if (!folder.isWritable) {
    // Upgrade at the version it installed updates the plugin only, before install restarts the service on it (#718).
    const isPluginOffered = at.plugin !== undefined && at.plugin.harnesses.length > 0;
    const pluginStep = `aeolus-trierarch upgrade ${target}`;
    const instead = [
      `sudo npm install --global ${spec}`,
      ...(isPluginOffered ? [pluginStep] : []),
      ...((await at.service.status()).isInstalled ? ['aeolus-trierarch install'] : []),
    ];
    const pluginSaid = isPluginOffered ? `${pluginStep} updates the aeolus-fleet plugin to ${target}. ` : '';
    throw new TrierarchFileError(
      `npm's global folder ${folder.path} is not yours to write: a system Node install owns it. Run instead:\n${instead.map((line) => `  ${line}`).join('\n')}\n${pluginSaid}The trierarch keeps running ${from}.`,
    );
  }
  const installed = await at.npm.install(spec);
  if (installed.status !== 0) {
    throw new TrierarchFileError(
      `npm install --global ${spec} failed: ${installed.stderr.trim()}\nThe trierarch keeps running ${from}. Fix what npm says, then run aeolus-trierarch upgrade again.`,
    );
  }
  const to = at.installedVersion();
  // This process runs the code of the version it replaces: the installed version runs its own plugin step (#725).
  const plugin = at.plugin === undefined || at.plugin.harnesses.length === 0 ? { isPluginUpdated: true, said: [] } : pluginStepOf(await at.upgradeInstalledPlugin(to), to);
  const said = [`Upgraded the trierarch from ${from} to ${to}.`, ...plugin.said];

  if ((await at.service.status()).isInstalled) {
    said.push(await restartOn(at, { from, to }));
  } else {
    said.push('The service is not installed: run aeolus-trierarch install to run it.');
  }
  return { from, to, isUpgraded: true, isPluginUpdated: plugin.isPluginUpdated, said };
}
