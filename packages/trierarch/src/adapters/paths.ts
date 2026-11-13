import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';

/**
 * Where the trierarch keeps its files (docs/architecture.md, "Files on the
 * machine"): everything under `~/.aeolus/trierarch/`. Every ship's files are
 * in its own folder under `ships/`, `ships/<shipId>/`, and no secret is in
 * one: the trierarch's own files, its tokens for its ships among them, sit
 * beside `ships/`. The configuration's path can be moved with `--config` or
 * AEOLUS_TRIERARCH_CONFIG, and the place of `ships/` by the configuration's
 * shipsRoot.
 */
export interface TrierarchPaths {
  readonly home: string;
  readonly config: string;
  readonly configSchema: string;
  readonly crewToken: string;
  /** The machine's long-lived model token, handed to each container session (decision 0039); never in the configuration. */
  readonly modelToken: string;
  /** Each harness's API key, one file per harness (api keys K5); only login writes it, never the configuration. */
  readonly keys: string;
  /** The model proxy's files, its pid and its port (headless H16). */
  readonly proxy: string;
  readonly state: string;
  /** What detection found per harness (#365), apart from the configuration. */
  readonly detected: string;
  readonly running: string;
  readonly logs: string;
  /** Every ship's own folder, `ships/<shipId>/`, unless the configuration's shipsRoot names another place. */
  readonly ships: string;
  /** The worktree root of the ships crewed before the ship folders, `<repository>/<ship>` under it. */
  readonly worktrees: string;
  /** The homes of the ships crewed before the ship folders whose sessions run in containers, one folder per ship (decision 0039). */
  readonly homes: string;
  /** Each session's hold files, its tokens among them, in a folder of its own (headless H8): never in the ship's folder. */
  readonly sessions: string;
  /** The socket of each ship crewed before the ship folders, in a folder of its own: its session's fleet calls come over it (decision 0026). */
  readonly sockets: string;
  /** The trusted repositories the trierarch plugin sent last (aeolus-fleet#384), apart from the configuration. */
  readonly trustedRepositories: string;
  /** The clones of the trusted repositories, one folder per repository (aeolus-fleet#384). */
  readonly repositories: string;
}

export function trierarchPaths(at: { homeDirectory: string; config?: string }): TrierarchPaths {
  const home = join(at.homeDirectory, '.aeolus', 'trierarch');
  return {
    home,
    config: at.config ?? join(home, 'config.json'),
    configSchema: join(home, 'config.schema.json'),
    crewToken: join(home, 'crew-token'),
    modelToken: join(home, 'model-token'),
    keys: join(home, 'keys'),
    proxy: join(home, 'proxy'),
    state: join(home, 'state.json'),
    detected: join(home, 'detected.json'),
    running: join(home, 'running.json'),
    logs: join(home, 'logs'),
    ships: join(home, 'ships'),
    worktrees: join(home, 'worktrees'),
    homes: join(home, 'homes'),
    sessions: join(home, 'sessions'),
    sockets: join(home, 'sockets'),
    trustedRepositories: join(home, 'trusted-repositories.json'),
    repositories: join(home, 'repositories'),
  };
}

/**
 * In a ship's folder, `ships/<shipId>/`: its ship folder (ship-folder.ts), its
 * harness's home in a container, and the folder of its sockets, which a
 * container mounts at the same path (a socket mounted alone would be the one
 * the trierarch had open when the container started).
 */
export const HOME_FOLDER = 'home';
export const SOCKETS_FOLDER = 'sockets';
/** The ship's fleet socket in its sockets folder (decision 0026). */
export const SOCKET_FILE = 'fleet.sock';

/** A ship as its files are found: by its ship's folder, or for a ship crewed before the ship folders (none) by its id. */
export interface ShipFiles {
  readonly shipId: ShipId;
  readonly shipFolder?: string;
}

/** The ship's own home, for a session in a container: in its ship's folder, or for a ship crewed before the ship folders under the homes as it was made. */
export function shipHome(homes: string, ship: ShipFiles): string {
  return ship.shipFolder === undefined ? join(homes, ship.shipId) : join(ship.shipFolder, HOME_FOLDER);
}

/** The folder of the ship's sockets: in its ship's folder, or for a ship crewed before the ship folders under the sockets folder as it was made. */
export function shipSockets(sockets: string, ship: ShipFiles): string {
  return ship.shipFolder === undefined ? join(sockets, ship.shipId) : join(ship.shipFolder, SOCKETS_FOLDER);
}

/** As long as a ship id gets: `shp_` and its 26 characters. */
const LONGEST_SHIP_ID = `shp_${'0'.repeat(26)}`;

/** The longest socket path a ship's folder under the place of ships/ holds. */
export function longestSocket(ships: string): string {
  return join(ships, LONGEST_SHIP_ID, SOCKETS_FOLDER, SOCKET_FILE);
}

/** The size of a socket's path the system takes, its ending zero byte with it. */
const SOCKET_PATH_LIMITS: Readonly<Record<string, number>> = { darwin: 104 };
const SOCKET_PATH_LIMIT = 108;

/** The size of a socket's path the system takes, its ending zero byte with it: 104 bytes on macOS, 108 elsewhere. */
export function socketPathLimit(platform: string): number {
  return SOCKET_PATH_LIMITS[platform] ?? SOCKET_PATH_LIMIT;
}
