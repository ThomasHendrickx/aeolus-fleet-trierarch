import { readFile } from 'node:fs/promises';

import type { HarnessPort, Turn } from '../core/ports.js';
import { runCommand } from './run-command.js';

/** The aeolus plugin as a harness installed it: its scripts and its data folder. */
export interface AeolusPlugin {
  readonly root: string;
  readonly data: string;
}

/**
 * A session's identity and turn, through the aeolus plugin's own
 * `aeolus-identity.sh`, never a copy of how the plugin names its files. The
 * same for every harness; each keeps them in its own plugin's data folder.
 */
export function createPluginIdentity(plugin: AeolusPlugin): Pick<HarnessPort, 'prepareIdentity' | 'crewTokenOf' | 'removeIdentity' | 'turnOf'> {
  const identity = async (folder: string, args: readonly string[]): Promise<{ status: number; stdout: string; stderr: string }> =>
    runCommand('bash', { args: [`${plugin.root}/scripts/aeolus-identity.sh`, ...args], env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: plugin.data } });

  return {
    prepareIdentity: async ({ folder, identity: crew }) => {
      const written = await identity(folder, [
        'write',
        '--wake-by',
        'trierarch',
        crew.fleetUrl,
        crew.shipId,
        crew.shipName,
        crew.crewToken,
        ...(crew.squadron === undefined ? [] : [crew.squadron]),
      ]);
      if (written.status !== 0) {
        throw new Error(`aeolus-identity.sh write failed: ${written.stderr.trim()}`);
      }
    },
    crewTokenOf: async (folder) => {
      const path = (await identity(folder, ['path'])).stdout.trim();
      const text = await readFile(path, 'utf8').catch(() => '');
      return /^crewToken=(.+)$/m.exec(text)?.[1];
    },
    removeIdentity: async (folder) => {
      await identity(folder, ['delete']);
    },
    turnOf: async (folder): Promise<Turn> => {
      const turn = await identity(folder, ['turn']);
      const [state] = turn.stdout.split(' ');
      return turn.status === 0 && (state === 'busy' || state === 'idle') ? state : 'unknown';
    },
  };
}
