import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { idSchema } from '@aeolus-fleet/common';

import { createTrierarchCallerCheck } from '../adapters/caller-check.js';
import { runHold } from '../adapters/hold.js';
import { holdFilesOf } from '../adapters/hold-protocol.js';
import { runningVersion } from '../adapters/version.js';

/**
 * `aeolus-trierarch hold <ship id> --sessions <folder> --folder <folder>
 * --harness <name> [--env NAME=value]... -- <command>...`: the hold of one
 * session (headless H8), as the trierarch starts it, never a person. The
 * harness's environment is built from nothing (H10): HOME, PATH, USER and
 * LOGNAME from the hold's own, then each `--env` given; nothing else of the
 * trierarch's.
 */

/**
 * What the harness takes of the hold's own environment; everything else it is
 * given. USER and LOGNAME name the user: on macOS Claude Code finds its login
 * in the Keychain by them, and without them it is not logged in.
 */
const KEPT_VARIABLES = ['HOME', 'PATH', 'USER', 'LOGNAME'] as const;

/** The harness's environment, from the hold's own and the variables given. */
export function harnessEnvironment(own: Readonly<Record<string, string | undefined>>, given: Readonly<Record<string, string>>): Record<string, string> {
  const kept = KEPT_VARIABLES.flatMap((variable) => {
    const value = own[variable];
    return value === undefined ? [] : [[variable, value] as const];
  });
  return { ...Object.fromEntries(kept), ...given };
}

/** The process each session runs under: every hold's, from its pid file. */
async function holdPids(sessions: string): Promise<number[]> {
  const folders = await readdir(sessions).catch(() => []);
  const pids = await Promise.all(folders.map(async (folder) => Number(await readFile(join(sessions, folder, 'hold.pid'), 'utf8').catch(() => ''))));
  return pids.filter((pid) => Number.isInteger(pid) && pid > 1);
}

/** Runs the hold with the words after `hold`; answers its exit code, or 2 for words it cannot take. */
export async function holdCommand(words: readonly string[], at: { env: Readonly<Record<string, string | undefined>>; platform: string }): Promise<number> {
  const end = words.indexOf('--');
  const [ship, ...options] = end === -1 ? words : words.slice(0, end);
  const command = end === -1 ? [] : words.slice(end + 1);
  const shipId = idSchema('ship').safeParse(ship);
  const valueOf = (name: string): string | undefined => options[options.indexOf(name) + 1];
  const sessions = valueOf('--sessions');
  const folder = valueOf('--folder');
  const harness = valueOf('--harness');
  if (!shipId.success || sessions === undefined || folder === undefined || harness === undefined || command.length === 0) {
    process.stderr.write('Usage: aeolus-trierarch hold <ship id> --sessions <folder> --folder <folder> --harness <name> [--env NAME=value]... -- <command>...\n');
    return 2;
  }
  const given = Object.fromEntries(
    options.flatMap((option, at) => {
      const pair = options[at - 1] === '--env' ? option : undefined;
      const separator = pair?.indexOf('=') ?? -1;
      return pair === undefined || separator < 1 ? [] : [[pair.slice(0, separator), pair.slice(separator + 1)]];
    }),
  );
  return runHold({
    files: holdFilesOf(sessions, shipId.data),
    folder,
    harness,
    command,
    environment: harnessEnvironment(at.env, given),
    version: runningVersion(),
    mayCall: createTrierarchCallerCheck({ platform: at.platform, sessionRoots: () => holdPids(sessions) }),
  });
}
