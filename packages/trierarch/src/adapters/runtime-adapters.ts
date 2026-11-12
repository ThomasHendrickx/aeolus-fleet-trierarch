import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { TrierarchConfiguration } from './files.js';

import type { FolderProcessesPort, SessionRuntime, TrashPort, WorkspacePort } from '../core/ports.js';
import type { SessionRoots } from './caller-check.js';
import { createCloneWorkspace } from './clone-workspace.js';
import { containerProxyUrl, createContainerRuntime } from './container.js';
import { createContainerFolderProcesses } from './container-folder-processes.js';
import { createFolderProcesses } from './folder-processes.js';
import { createGitWorkspace } from './git-workspace.js';
import type { TrustedClones } from './trusted-clones.js';
import type { TrierarchPaths } from './paths.js';
import { createHoldRuntime } from './hold-runtime.js';
import { createProxyRuntime, type ProxyRuntime } from './proxy-runtime.js';
import { createTrash, foldersUnder, moveWithinUserNamespace, removeWithinUserNamespace, type MoveWithinUserNamespace } from './trash.js';

/** The session image `release.yml` publishes with each version (decision 0011, 0039). */
const SESSION_IMAGE = 'ghcr.io/thomashendrickx/aeolus-session';

/** The trierarch program as it runs now, which starts each hold: `hold` and its words follow. */
const TRIERARCH_PROGRAM: readonly string[] = [process.execPath, fileURLToPath(new URL('../bin/aeolus-trierarch.js', import.meta.url))];

/** The model proxy on this machine (headless H16), started as a hold is. */
export function modelProxy(at: { paths: TrierarchPaths; version: string; launch?: readonly string[] }): ProxyRuntime {
  return createProxyRuntime({ folder: at.paths.proxy, sessions: at.paths.sessions, keys: at.paths.keys, program: TRIERARCH_PROGRAM, version: at.version, launch: at.launch ?? [] });
}

/** The sessions on the host (headless H4, H8): one hold per ship. */
export function hostSessions(at: { paths: TrierarchPaths; version: string; launch?: readonly string[]; program?: readonly string[] }): SessionRuntime & SessionRoots {
  return createHoldRuntime({ sessions: at.paths.sessions, program: at.program ?? TRIERARCH_PROGRAM, version: at.version, platform: process.platform, launch: at.launch ?? [] });
}

/** What runs the sessions, where their workspaces go, and, in containers, where each ship's home is kept. */
export interface RuntimeAdapters {
  readonly sessions: SessionRuntime & SessionRoots;
  readonly workspace: WorkspacePort;
  /** The processes running in a folder, stopped before an orphan worktree is read and removed; in containers, only once no container works in it. */
  readonly folderProcesses: FolderProcessesPort;
  /** The homes of the ships, one each, for sessions in containers; none on the host, where every session shares the user's. */
  readonly shipHomes?: { homes: string; managedSettings: string; moveWithinUserNamespace?: MoveWithinUserNamespace };
  /** The trash beside each repository's clones and the ships' homes, emptied every pass: within the runtime's user namespace too in containers, by the host's own removal alone on the host. */
  readonly trash: TrashPort;
  /** Where a session reaches the model proxy the trierarch reaches at the url (headless H16): there on the host, on its own loopback in a container, where only the proxy's port is forwarded. */
  readonly modelProxyUrlOf: (url: string) => string;
}

/**
 * The adapters the configuration's session runtime picks (decision 0039): on
 * the host, a hold per ship and a worktree per ship (headless H4); in containers, a container per ship
 * run by its hold (H18), from the image of the trierarch's own version, with the configured binary
 * and caps and the machine's model token, a clone per ship in place of the
 * worktree, by its real path, and a home of each ship's own.
 */
export function runtimeAdaptersOf(at: {
  configuration: TrierarchConfiguration;
  paths: TrierarchPaths;
  version: string;
  launch: readonly string[];
  managedSettings: string;
  /** Where the model proxy listens on the host's loopback; none while it is not running. */
  proxyUrl: () => Promise<string | undefined>;
  /** The trusted repositories a workspace clones first when the machine does not have them (aeolus-fleet#384). */
  clones?: TrustedClones;
  /** The trierarch program that starts each hold; the one running now unless a test runs another. */
  program?: readonly string[];
}): RuntimeAdapters {
  const { configuration, paths, version, launch, managedSettings, clones: trusted } = at;
  const root = configuration.shipsRoot ?? paths.worktrees;
  const { runtime } = configuration;
  if (runtime?.kind !== 'container') {
    return {
      modelProxyUrlOf: (url) => url,
      sessions: hostSessions({ paths, version, launch, ...(at.program !== undefined && { program: at.program }) }),
      workspace: createGitWorkspace({ configuration, root, ...(trusted !== undefined && { clones: trusted }) }),
      folderProcesses: createFolderProcesses(),
      trash: createTrash({ beside: foldersUnder([root]) }),
    };
  }
  // A clone or a ship's home whose own top the host cannot give its write goes to the trash as the runtime moves it.
  const moveAsRuntime = moveWithinUserNamespace(runtime.binary);
  const clones = createCloneWorkspace({ configuration, root, moveWithinUserNamespace: moveAsRuntime, ...(trusted !== undefined && { clones: trusted }) });
  return {
    sessions: createContainerRuntime({
      binary: runtime.binary,
      image: `${SESSION_IMAGE}:${version}`,
      tokenFile: paths.modelToken,
      homes: paths.homes,
      sockets: paths.sockets,
      memory: runtime.memory,
      cpus: runtime.cpus,
      sessions: paths.sessions,
      program: at.program ?? TRIERARCH_PROGRAM,
      version,
      platform: process.platform,
      launch,
      proxyUrl: at.proxyUrl,
    }),
    // The container mounts the folder at the path it is given, where the plugin inside keys it by `pwd -P` as the host's does: one path for both, the real one.
    workspace: {
      ...clones,
      prepare: async (at) => ({ folder: await realpath((await clones.prepare(at)).folder) }),
      // Listed by the same real paths, so a folder a ship is crewed in is never taken for one no crewed ship uses.
      foldersUnderRoot: async () => Promise.all((await clones.foldersUnderRoot()).map(async (folder) => realpath(folder).catch(() => folder))),
    },
    folderProcesses: createContainerFolderProcesses({ binary: runtime.binary, host: createFolderProcesses() }),
    shipHomes: { homes: paths.homes, managedSettings, moveWithinUserNamespace: moveAsRuntime },
    trash: createTrash({ beside: async () => [...(await foldersUnder([root])()), paths.homes], unshare: removeWithinUserNamespace(runtime.binary) }),
    modelProxyUrlOf: containerProxyUrl,
  };
}
