import { realpath } from 'node:fs/promises';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { SessionRuntime, WorkspacePort } from '../core/ports.js';
import { createCloneWorkspace } from './clone-workspace.js';
import { createContainerRuntime } from './container.js';
import { createGitWorkspace } from './git-workspace.js';
import type { TrierarchPaths } from './paths.js';
import { createTmux } from './tmux.js';

/** The session image `release.yml` publishes with each version (decision 0011, 0039). */
const SESSION_IMAGE = 'ghcr.io/thomashendrickx/aeolus-session';

/** What runs the sessions, where their workspaces go, and, in containers, where each ship's home is kept. */
export interface RuntimeAdapters {
  readonly sessions: SessionRuntime;
  readonly workspace: WorkspacePort;
  /** The homes of the ships, one each, for sessions in containers; none on the host, where every session shares the user's. */
  readonly shipHomes?: { homes: string; managedSettings: string };
}

/**
 * The adapters the configuration's session runtime picks (decision 0039): on
 * the host, tmux and a worktree per ship; in containers, a container per ship
 * from the image of the trierarch's own version, with the configured binary
 * and caps and the machine's model token, a clone per ship in place of the
 * worktree, by its real path, and a home of each ship's own.
 */
export function runtimeAdaptersOf(at: { configuration: TrierarchConfiguration; paths: TrierarchPaths; version: string; launch: readonly string[]; managedSettings: string }): RuntimeAdapters {
  const { configuration, paths, version, launch, managedSettings } = at;
  const root = configuration.worktreeRoot ?? paths.worktrees;
  const { runtime } = configuration;
  if (runtime?.kind !== 'container') {
    return { sessions: createTmux({ launch }), workspace: createGitWorkspace({ configuration, root }) };
  }
  const clones = createCloneWorkspace({ configuration, root });
  return {
    sessions: createContainerRuntime({ binary: runtime.binary, image: `${SESSION_IMAGE}:${version}`, tokenFile: paths.modelToken, homes: paths.homes, memory: runtime.memory, cpus: runtime.cpus, launch }),
    // The container mounts the folder at the path it is given, where the plugin inside keys it by `pwd -P` as the host's does: one path for both, the real one.
    workspace: { ...clones, prepare: async (at) => ({ folder: await realpath((await clones.prepare(at)).folder) }) },
    shipHomes: { homes: paths.homes, managedSettings },
  };
}
