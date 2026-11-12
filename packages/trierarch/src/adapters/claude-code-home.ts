import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createClaudeCodeSetup, type ClaudeCodeSetup } from './claude-code-setup.js';
import { shipHome, type ShipFiles } from './paths.js';
import type { AeolusPlugin } from './plugin-identity.js';
import { PLUGIN_DATA_FOLDER } from './plugin.js';
import { discard, type MoveWithinUserNamespace } from './trash.js';

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
  of(ship: ShipFiles): ClaudeCodeHome;
  /** Answers Claude Code's one-time questions in the ship's home before a launch, a restart too, so the session asks nothing (#403). */
  prepare(session: ShipFiles & { folder: string }): Promise<void>;
  /** Removes the home of a ship crewed before the ship folders, once its identity goes; one in a ship's folder goes with that folder. */
  remove(ship: ShipFiles): Promise<void>;
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
 * A home of each ship's own in its ship's folder (`<ships>/<shipId>/home`), or
 * for a ship crewed before the ship folders under `homes`
 * (`~/.aeolus/trierarch/homes/<shipId>`), holding its identity and Claude
 * Code's files and nothing of another ship.
 * The identity goes through the host's aeolus-fleet plugin scripts into the home's
 * crews folder, where the image's plugin of the same version finds it. Before
 * each launch, the onboarding is completed and the workspace trusted at its
 * path, which the container mounts at the same path; bypass permissions mode
 * is accepted only where the operator accepted it on the host (#403). One
 * under `homes` goes with the ship's identity, as on a release, through the
 * trash beside it; one in a ship's folder goes with that folder.
 */
export function createShipClaudeCodeHomes(at: { homes: string; managedSettings: string; moveWithinUserNamespace?: MoveWithinUserNamespace; pluginRoot: AeolusPlugin['root']; host: Pick<ClaudeCodeSetup, 'isSkipPermissionsAccepted'> }): ClaudeCodeHomes {
  const setupOf = (ship: ShipFiles): ClaudeCodeSetup => createClaudeCodeSetup({ homeDirectory: shipHome(at.homes, ship), managedSettings: at.managedSettings });

  return {
    of: (ship) => {
      const home = shipHome(at.homes, ship);
      return {
        plugin: { root: at.pluginRoot, data: join(home, '.claude', 'plugins', 'data', PLUGIN_DATA_FOLDER), crews: join(home, '.aeolus', 'crews', 'claude-code') },
        projects: join(home, '.claude', 'projects'),
        setup: setupOf(ship),
      };
    },
    prepare: async ({ folder, ...ship }) => {
      await mkdir(shipHome(at.homes, ship), { recursive: true, mode: PRIVATE_FOLDER_MODE });
      const setup = setupOf(ship);
      await setup.completeOnboarding();
      await setup.trust(folder);
      if (await at.host.isSkipPermissionsAccepted()) {
        await setup.acceptSkipPermissions();
      }
    },
    remove: async (ship) => {
      if (ship.shipFolder !== undefined) {
        return;
      }
      const home = shipHome(at.homes, ship);
      // One already gone is removed already.
      if ((await lstat(home).catch(() => undefined)) === undefined) {
        return;
      }
      // Aside at once, so the release goes on whatever its session left in it; the trash removes it (docs/trierarch.md, "Session runtime").
      await discard(home, { at: new Date(), ...(at.moveWithinUserNamespace !== undefined && { withinUserNamespace: at.moveWithinUserNamespace }) });
    },
  };
}
