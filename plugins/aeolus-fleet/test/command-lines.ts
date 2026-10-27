/**
 * A PATH that records the command line of every program started through it:
 * what `ps` and /proc/<pid>/cmdline show any local user while it runs (#822).
 * Each program name on the caller's PATH is a link to one recorder, which
 * writes its name and arguments down, then runs the real program.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface RecordingPath {
  /** The PATH to run with: the recorder's folder, then the caller's own. */
  readonly path: string;
  /** Every command line recorded so far, one per line. */
  commandLines(): string;
}

/** Makes a recording PATH in the folder given, over the caller's PATH. */
export function recordingPath(folder: string, callerPath: string = process.env.PATH ?? ''): RecordingPath {
  const bin = join(folder, 'recording-bin');
  const log = join(folder, 'command-lines');
  const recorder = join(folder, 'record-command-line');
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, '');
  // Plain sh at its own path, so the recorder never runs itself; only its builtins before the exec.
  writeFileSync(
    recorder,
    [
      '#!/bin/sh',
      'name="${0##*/}"',
      `printf '%s %s\\n' "$name" "$*" >> '${log}'`,
      `IFS='${delimiter}'`,
      `for dir in $AEOLUS_REAL_PATH; do`,
      '  if [ -f "$dir/$name" ] && [ -x "$dir/$name" ]; then exec "$dir/$name" "$@"; fi',
      'done',
      'exit 127',
      '',
    ].join('\n'),
  );
  chmodSync(recorder, 0o700);
  for (const dir of callerPath.split(delimiter)) {
    if (dir === '' || !existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!existsSync(join(bin, name))) symlinkSync(recorder, join(bin, name));
    }
  }
  return {
    path: `${bin}${delimiter}${callerPath}`,
    commandLines: () => readFileSync(log, 'utf8'),
  };
}

/** The variables a recording PATH needs: the PATH, and the real one its recorder runs programs from. */
export function recordingEnvironment(recording: RecordingPath, callerPath: string = process.env.PATH ?? ''): Record<string, string> {
  return { PATH: recording.path, AEOLUS_REAL_PATH: callerPath };
}
