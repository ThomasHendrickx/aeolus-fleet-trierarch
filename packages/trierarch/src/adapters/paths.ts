import { join } from 'node:path';

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
  readonly state: string;
  /** What detection found per harness (#365), apart from the configuration. */
  readonly detected: string;
  readonly running: string;
  readonly logs: string;
  readonly worktrees: string;
}

export function trierarchPaths(at: { homeDirectory: string; config?: string }): TrierarchPaths {
  const home = join(at.homeDirectory, '.aeolus', 'trierarch');
  return {
    home,
    config: at.config ?? join(home, 'config.json'),
    configSchema: join(home, 'config.schema.json'),
    crewToken: join(home, 'crew-token'),
    state: join(home, 'state.json'),
    detected: join(home, 'detected.json'),
    running: join(home, 'running.json'),
    logs: join(home, 'logs'),
    worktrees: join(home, 'worktrees'),
  };
}
