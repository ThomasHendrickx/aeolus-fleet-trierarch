import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';

/**
 * Where the trierarch keeps its files (docs/architecture.md, "Files on the
 * machine"): everything under `~/.aeolus/trierarch/`. The configuration's
 * path can be moved with `--config` or AEOLUS_TRIERARCH_CONFIG, and the
 * worktree root by the configuration.
 */
export interface TrierarchPaths {
  readonly home: string;
  readonly config: string;
  readonly configSchema: string;
  readonly crewToken: string;
  /** The machine's long-lived model token, handed to each container session (decision 0039); never in the configuration. */
  readonly modelToken: string;
  readonly state: string;
  /** What detection found per harness (#365), apart from the configuration. */
  readonly detected: string;
  readonly running: string;
  readonly logs: string;
  readonly worktrees: string;
  /** The homes of the ships whose sessions run in containers, one folder per ship (decision 0039). */
  readonly homes: string;
  /** Each crewed ship's socket, in a folder of its own: its session's fleet calls come over it (decision 0026). */
  readonly sockets: string;
  /** Each crewed ship's read-only checkouts, in a folder of its own (#1182). */
  readonly checkouts: string;
}

export function trierarchPaths(at: { homeDirectory: string; config?: string }): TrierarchPaths {
  const home = join(at.homeDirectory, '.aeolus', 'trierarch');
  return {
    home,
    config: at.config ?? join(home, 'config.json'),
    configSchema: join(home, 'config.schema.json'),
    crewToken: join(home, 'crew-token'),
    modelToken: join(home, 'model-token'),
    state: join(home, 'state.json'),
    detected: join(home, 'detected.json'),
    running: join(home, 'running.json'),
    logs: join(home, 'logs'),
    worktrees: join(home, 'worktrees'),
    homes: join(home, 'homes'),
    sockets: join(home, 'sockets'),
    checkouts: join(home, 'checkouts'),
  };
}

/** A ship's own home among the homes: the one place a ship id becomes its home's path. */
export function shipHome(homes: string, shipId: ShipId): string {
  return join(homes, shipId);
}
