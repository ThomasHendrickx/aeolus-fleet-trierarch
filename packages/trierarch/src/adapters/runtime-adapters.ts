import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { SessionRuntime, WorkspacePort } from '../core/ports.js';
import type { SessionRoots } from './caller-check.js';
import { createCloneWorkspace } from './clone-workspace.js';
import { createContainerRuntime } from './container.js';
import { createGitWorkspace } from './git-workspace.js';
import type { TrustedClones } from './trusted-clones.js';
import type { TrierarchPaths } from './paths.js';
import { createHoldRuntime } from './hold-runtime.js';
import { createTmux } from './tmux.js';

/** The session image `release.yml` publishes with each version (decision 0011, 0039). */
const SESSION_IMAGE = 'ghcr.io/thomashendrickx/aeolus-session';

/** The trierarch program as it runs now, which starts each hold: `hold` and its words follow. */
const TRIERARCH_PROGRAM: readonly string[] = [process.execPath, fileURLToPath(new URL('../bin/aeolus-trierarch.js', import.meta.url))];

/**
 * The sessions on the host (headless H4, H8): one hold per ship, with the
 * sessions an older trierarch started in tmux listed beside them until each
 * is replaced (H19).
 */
export function hostSessions(at: { paths: TrierarchPaths; version: string; launch?: readonly string[]; program?: readonly string[] }): SessionRuntime & SessionRoots {
  return createHoldRuntime({ sessions: at.paths.sessions, program: at.program ?? TRIERARCH_PROGRAM, version: at.version, platform: process.platform, launch: at.launch ?? [], legacy: createTmux() });
}

/** What runs the sessions, where their workspaces go, and, in containers, where each ship's home is kept. */
export interface RuntimeAdapters {
  readonly sessions: SessionRuntime & SessionRoots;
  readonly workspace: WorkspacePort;
  /** The homes of the ships, one each, for sessions in containers; none on the host, where every session shares the user's. */
  readonly shipHomes?: { homes: string; managedSettings: string };
}

/**
 * The adapters the configuration's session runtime picks (decision 0039): on
 * the host, a hold per ship and a worktree per ship (headless H4); in containers, a container per ship
 * from the image of the trierarch's own version, with the configured binary
 * and caps and the machine's model token, a clone per ship in place of the
 * worktree, by its real path, and a home of each ship's own.
 */
export function runtimeAdaptersOf(at: {
  configuration: TrierarchConfiguration;
  paths: TrierarchPaths;
  version: string;
  launch: readonly string[];
  managedSettings: string;
  /** The trusted repositories a workspace clones first when the machine does not have them (aeolus-fleet#384). */
  clones?: TrustedClones;
  /** The trierarch program that starts each hold; the one running now unless a test runs another. */
  program?: readonly string[];
}): RuntimeAdapters {
  const { configuration, paths, version, launch, managedSettings, clones: trusted } = at;
  const root = configuration.worktreeRoot ?? paths.worktrees;
  const { runtime } = configuration;
  if (runtime?.kind !== 'container') {
    return { sessions: hostSessions({ paths, version, launch, ...(at.program !== undefined && { program: at.program }) }), workspace: createGitWorkspace({ configuration, root, ...(trusted !== undefined && { clones: trusted }) }) };
  }
  const clones = createCloneWorkspace({ configuration, root, ...(trusted !== undefined && { clones: trusted }) });
  return {
    sessions: createContainerRuntime({ binary: runtime.binary, image: `${SESSION_IMAGE}:${version}`, tokenFile: paths.modelToken, homes: paths.homes, sockets: paths.sockets, memory: runtime.memory, cpus: runtime.cpus, launch }),
    // The container mounts the folder at the path it is given, where the plugin inside keys it by `pwd -P` as the host's does: one path for both, the real one.
    workspace: { ...clones, prepare: async (at) => ({ folder: await realpath((await clones.prepare(at)).folder) }) },
    shipHomes: { homes: paths.homes, managedSettings },
  };
}
