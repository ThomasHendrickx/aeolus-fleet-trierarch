import { readFile } from 'node:fs/promises';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { HarnessPort, Turn } from '../core/ports.js';
import { effectiveFlags } from './flags.js';
import { runCommand } from './run-command.js';
import type { Tmux } from './tmux.js';

/**
 * Claude Code as a harness (docs/architecture.md, "First adapters"): `claude`
 * in the folder, `--continue` on a restart, `/aeolus:wake` typed to wake an
 * idle session. A session's identity is written and read through the aeolus
 * plugin's own `aeolus-identity.sh`, never a copy of how the plugin names its
 * files.
 */

/** The aeolus plugin as Claude Code installed it: its scripts and its data folder. */
export interface AeolusPlugin {
  readonly root: string;
  readonly data: string;
}

export const WAKE_PROMPT = '/aeolus:wake';

export function createClaudeCodeHarness(options: {
  configuration: TrierarchConfiguration;
  plugin: AeolusPlugin;
  sessions: Pick<Tmux, 'start' | 'type'>;
  /** The program to run; `claude` unless a test runs another. */
  command?: string;
}): HarnessPort {
  const { configuration, plugin, sessions } = options;
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
    launch: async ({ shipId, folder, harness, options: picked, isFirstStart, firstPrompt }) => {
      const settings = configuration.harnesses[harness];
      if (settings === undefined) {
        throw new Error(`The configuration has no harness ${harness}`);
      }
      const prompt = isFirstStart && firstPrompt !== undefined ? firstPrompt : WAKE_PROMPT;
      const command = [options.command ?? 'claude', ...effectiveFlags(settings, picked), ...(isFirstStart ? [] : ['--continue']), prompt];
      await sessions.start({ shipId, folder, command });
    },
    turnOf: async (folder): Promise<Turn> => {
      const turn = await identity(folder, ['turn']);
      const [state] = turn.stdout.split(' ');
      return turn.status === 0 && (state === 'busy' || state === 'idle') ? state : 'unknown';
    },
    wake: async ({ shipId }) => {
      await sessions.type({ shipId, text: WAKE_PROMPT });
    },
  };
}
