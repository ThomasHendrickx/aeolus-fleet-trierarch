import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';

import { createClaudeCodeSetup, type ClaudeCodeSetup } from './claude-code-setup.js';
import { shipHome } from './paths.js';
import type { AeolusPlugin } from './plugin-identity.js';
import { PLUGIN_DATA_FOLDER } from './plugin.js';

/** Where a ship's Claude Code session keeps its files: its identity through the aeolus-fleet plugin, its conversations, and Claude Code's own files. */
export interface ClaudeCodeHome {
  readonly plugin: AeolusPlugin;
  /** Claude Code's projects folder, where it keeps each folder's conversations. */
  readonly projects: string;
  readonly setup: Pick<ClaudeCodeSetup, 'completeOnboarding' | 'defaultPermissionMode'>;
}

/**
 * The homes of the Claude Code sessions (decision 0039): on the host every
 * session shares the user's own home; in containers each ship has a home of
 * its own, which its container gets as its home.
 */
export interface ClaudeCodeHomes {
  of(shipId: ShipId): ClaudeCodeHome;
  /** Answers Claude Code's one-time questions in the ship's home before a launch, a restart too, so the session asks nothing (#403). */
  prepare(session: { shipId: ShipId; folder: string }): Promise<void>;
  /** Removes the ship's home, once its identity goes. */
  remove(shipId: ShipId): Promise<void>;
}

/** The host's own home for every session: its onboarding completed before each launch; it is never removed. */
export function createHostClaudeCodeHomes(home: ClaudeCodeHome): ClaudeCodeHomes {
  return {
    of: () => home,
    prepare: () => home.setup.completeOnboarding(),
    remove: () => Promise.resolve(),
  };
}

/** A home only its owner reads, as it holds the ship's crew token. */
const PRIVATE_FOLDER_MODE = 0o700;

/**
 * A home of each ship's own under `homes` (`~/.aeolus/trierarch/homes/<shipId>`),
 * holding its identity and Claude Code's files and nothing of another ship.
 * The identity goes through the host's aeolus-fleet plugin scripts into the home's
 * crews folder, where the image's plugin of the same version finds it. Before
 * each launch, the onboarding is completed and the workspace trusted at its
 * path, which the container mounts at the same path; bypass permissions mode
 * is accepted only where the operator accepted it on the host (#403). It goes
 * with the ship's identity, as on a release.
 */
export function createShipClaudeCodeHomes(at: { homes: string; managedSettings: string; pluginRoot: AeolusPlugin['root']; host: Pick<ClaudeCodeSetup, 'isSkipPermissionsAccepted'> }): ClaudeCodeHomes {
  const setupOf = (shipId: ShipId): ClaudeCodeSetup => createClaudeCodeSetup({ homeDirectory: shipHome(at.homes, shipId), managedSettings: at.managedSettings });

  return {
    of: (shipId) => {
      const home = shipHome(at.homes, shipId);
      return {
        plugin: { root: at.pluginRoot, data: join(home, '.claude', 'plugins', 'data', PLUGIN_DATA_FOLDER), crews: join(home, '.aeolus', 'crews', 'claude-code') },
        projects: join(home, '.claude', 'projects'),
        setup: setupOf(shipId),
      };
    },
    prepare: async ({ shipId, folder }) => {
      await mkdir(shipHome(at.homes, shipId), { recursive: true, mode: PRIVATE_FOLDER_MODE });
      const setup = setupOf(shipId);
      await setup.completeOnboarding();
      await setup.trust(folder);
      if (await at.host.isSkipPermissionsAccepted()) {
        await setup.acceptSkipPermissions();
      }
    },
    remove: async (shipId) => {
      await rm(shipHome(at.homes, shipId), { recursive: true, force: true });
    },
  };
}
