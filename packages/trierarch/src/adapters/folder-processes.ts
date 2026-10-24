import { spawnSync } from 'node:child_process';
import { readdirSync, readlinkSync } from 'node:fs';
import { sep } from 'node:path';

import type { FolderProcessesPort } from '../core/ports.js';

/**
 * The processes running in a folder (#1041), found by their working folder:
 * a dev server a session started stays up after its ship is retired, and
 * removing the folder under it would leave it running from nowhere. They are
 * asked to end, and those still running after a grace period are killed.
 */

/** A running process and the folder it works in. */
export interface ProcessFolder {
  readonly pid: number;
  readonly folder: string;
}

const GRACE_MS = 5000;
const POLL_MS = 100;
/** How Linux names the working folder of a process whose folder was removed. */
const DELETED_SUFFIX = ' (deleted)';

/** The working folders `lsof -d cwd -Fpn` says: a `p` line names a process, the `n` line after it its folder. */
export function foldersFromLsof(text: string): ProcessFolder[] {
  const found: ProcessFolder[] = [];
  let pid: number | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n') && pid !== undefined) {
      found.push({ pid, folder: line.slice(1) });
    }
  }
  return found;
}

/** Whether the process's folder is the folder or inside it. */
export function isInside(processFolder: string, folder: string): boolean {
  const own = processFolder.endsWith(DELETED_SUFFIX) ? processFolder.slice(0, -DELETED_SUFFIX.length) : processFolder;
  return own === folder || own.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

/** Every process's working folder: from /proc where the machine has it, else from lsof (macOS). */
export function readProcessFolders(): ProcessFolder[] {
  try {
    return readdirSync('/proc').flatMap((name) => {
      if (!/^\d+$/.test(name)) {
        return [];
      }
      try {
        return [{ pid: Number(name), folder: readlinkSync(`/proc/${name}/cwd`) }];
      } catch {
        // A process of another user, or one that ended since the listing: not ours to stop.
        return [];
      }
    });
  } catch {
    const listed = spawnSync('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8' });
    return foldersFromLsof(listed.stdout);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, name: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(pid, name);
  } catch {
    // Ended already.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFolderProcesses(at: { processFolders?: () => ProcessFolder[]; graceMs?: number } = {}): FolderProcessesPort {
  const processFolders = at.processFolders ?? readProcessFolders;
  const graceMs = at.graceMs ?? GRACE_MS;
  return {
    stopIn: async (folder) => {
      // Never the trierarch itself, whose own folder may be anywhere.
      const pids = processFolders()
        .filter((each) => each.pid !== process.pid && isInside(each.folder, folder))
        .map((each) => each.pid);
      for (const pid of pids) {
        signal(pid, 'SIGTERM');
      }
      for (let waited = 0; waited < graceMs && pids.some(isAlive); waited += POLL_MS) {
        await sleep(POLL_MS);
      }
      for (const pid of pids.filter(isAlive)) {
        signal(pid, 'SIGKILL');
      }
      return pids.length;
    },
  };
}
