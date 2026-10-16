import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';

import type { HarnessPort, Turn } from '../core/ports.js';
import { runCommand } from './run-command.js';

/** The aeolus plugin as a harness installed it: its scripts, its data folder, and where its sessions' identities live. */
export interface AeolusPlugin {
  /** Where the plugin's scripts are, resolved at each use: a plugin upgrade moves them to its new version's folder (#828). */
  readonly root: () => Promise<string>;
  readonly data: string;
  /** ~/.aeolus/crews/<harness> (#658). */
  readonly crews: string;
}

/** Runs the plugin's own `aeolus-identity.sh` for the folder, with the plugin's data and crews folders, and its input on stdin when there is one. */
export async function runIdentity(plugin: AeolusPlugin, at: { folder: string; args: readonly string[]; input?: string }): Promise<{ status: number; stdout: string; stderr: string }> {
  return runCommand('bash', { args: [`${await plugin.root()}/scripts/aeolus-identity.sh`, ...at.args], env: { AEOLUS_FOLDER: at.folder, AEOLUS_DATA: plugin.data, AEOLUS_CREWS: plugin.crews }, ...(at.input !== undefined && { input: at.input }) });
}

/** Runs the plugin's own `aeolus-push.sh` for the folder (#756), as `runIdentity` runs `aeolus-identity.sh`. */
async function runPush(plugin: AeolusPlugin, at: { folder: string; args: readonly string[] }): Promise<{ status: number; stdout: string; stderr: string }> {
  return runCommand('bash', { args: [`${await plugin.root()}/scripts/aeolus-push.sh`, ...at.args], env: { AEOLUS_FOLDER: at.folder, AEOLUS_DATA: plugin.data, AEOLUS_CREWS: plugin.crews } });
}

/** The states of a store entry the trierarch hands over (#756): received, handed and not confirmed, or to hand once more. */
const TO_HAND = new Set(['received', 'handed', 'onceMore']);

/** What the plugin does for a hand-over: the line to type into the session, or none when nothing is handed. */
export interface PluginHandOver {
  readonly handOverLine: (session: { shipId: ShipId; folder: string }) => Promise<string | undefined>;
}

/**
 * A session's identity and turn, through the aeolus plugin's own
 * `aeolus-identity.sh`, never a copy of how the plugin names its files. The
 * same for every harness; each keeps them in a crews folder of its own. The
 * data folder goes along, so the script moves an identity an older plugin
 * kept there.
 */
export function createPluginIdentity(plugin: AeolusPlugin): Pick<HarnessPort, 'prepareIdentity' | 'crewTokenOf' | 'removeIdentity' | 'turnOf' | 'isHolding' | 'sessionDied' | 'startProblem'> & PluginHandOver {
  const identity = (folder: string, args: readonly string[]) => runIdentity(plugin, { folder, args });

  return {
    // The crew token goes on stdin, never as an argument: any local user reads a process's command line (#822).
    prepareIdentity: async ({ folder, identity: crew }) => {
      const written = await runIdentity(plugin, {
        folder,
        args: ['write', '--wake-by', 'trierarch', crew.fleetUrl, crew.shipId, crew.shipName, ...(crew.squadron === undefined ? [] : [crew.squadron])],
        input: `${crew.crewToken}\n`,
      });
      if (written.status !== 0) {
        throw new Error(`aeolus-identity.sh write failed: ${written.stderr.trim()}`);
      }
    },
    crewTokenOf: async ({ folder }) => {
      const path = (await identity(folder, ['path'])).stdout.trim();
      const text = await readFile(path, 'utf8').catch(() => '');
      return /^crewToken=(.+)$/m.exec(text)?.[1];
    },
    removeIdentity: async ({ folder }) => {
      await identity(folder, ['delete']);
    },
    turnOf: async ({ folder }): Promise<Turn> => {
      const turn = await identity(folder, ['turn']);
      const [state] = turn.stdout.split(' ');
      return turn.status === 0 && (state === 'busy' || state === 'idle') ? state : 'unknown';
    },
    // The store keeps one line per entry: its delivery id, its state and when.
    isHolding: async ({ folder }) => (await identity(folder, ['store'])).stdout.split('\n').some((line) => TO_HAND.has(line.split(' ')[1] ?? '')),
    // Exit 0 hands a message over and prints its line; anything else hands nothing.
    handOverLine: async ({ folder }) => {
      const handed = await runPush(plugin, { folder, args: ['hand'] });
      const line = handed.stdout.trim();
      return handed.status === 0 && line !== '' ? line : undefined;
    },
    // The identity script stands for the scripts: a session cannot start without them (#827).
    startProblem: async () => {
      const scripts = join(await plugin.root(), 'scripts');
      return access(join(scripts, 'aeolus-identity.sh')).then(
        () => undefined,
        () => `the aeolus plugin's scripts are not at ${scripts}`,
      );
    },
    sessionDied: async ({ folder }) => {
      const died = await runPush(plugin, { folder, args: ['died'] });
      if (died.status !== 0) {
        throw new Error(`aeolus-push.sh died failed: ${died.stderr.trim()}`);
      }
    },
  };
}
