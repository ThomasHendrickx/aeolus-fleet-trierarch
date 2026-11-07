import { realpath } from 'node:fs/promises';

import type { FolderProcessesPort } from '../core/ports.js';
import { type CommandResult, runCommand } from './run-command.js';

/**
 * The processes running in a folder when sessions run in containers
 * (#1041): a container's processes are no process the host finds by its
 * working folder, and while one runs with the folder mounted its session can
 * still write the folder, `.git` included. So the host stops what runs in a
 * folder, and then reads it, only once no container works in it: one that
 * does, or a runtime that cannot say, leaves the folder for the next pass.
 */

/** The states of a container that runs nothing, as Podman and Docker name them. */
const RUNS_NOTHING: ReadonlySet<string> = new Set(['exited', 'stopped', 'dead']);

export function createContainerFolderProcesses(options: { binary: string; host: FolderProcessesPort; run?: (command: string, options: { args: readonly string[] }) => Promise<CommandResult> }): FolderProcessesPort {
  const run = options.run ?? runCommand;
  /** The containers that work in the folder, mounted at its path. */
  const workingIn = async (folder: string): Promise<string[]> => {
    const listed = await run(options.binary, { args: ['ps', '--all', '--filter', `volume=${folder}`, '--format', '{{.Names}} {{.State}}'] });
    if (listed.status !== 0) {
      throw new Error(`Cannot tell whether a container works in ${folder}, so it is left for the next pass: ${listed.stderr.trim()}`);
    }
    return listed.stdout.split('\n').flatMap((line) => {
      const [name = '', state = ''] = line.trim().split(' ');
      return name !== '' && !RUNS_NOTHING.has(state) ? [name] : [];
    });
  };
  return {
    stopIn: async (folder) => {
      // A container mounts a folder by its real path.
      const paths = new Set([folder, await realpath(folder).catch(() => folder)]);
      for (const path of paths) {
        const working = await workingIn(path);
        if (working.length > 0) {
          throw new Error(`A container works in ${folder}, so it is left for the next pass: ${working.join(', ')}`);
        }
      }
      return options.host.stopIn(folder);
    },
  };
}
