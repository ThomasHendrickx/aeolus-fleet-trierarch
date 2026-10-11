import { copyFileSync, fstatSync, mkdirSync, rmdirSync, statSync, truncateSync } from 'node:fs';

import type { LogStream } from './log.js';

/**
 * The trierarch's log file capped, by the rule the aeolus plugin's log follows
 * (plugins/aeolus/README.md, "The log"): before a record, a log that reached
 * 1 MiB moves aside as `trierarch.log.1`, replacing an older one, and the
 * record starts a new log. On macOS launchd writes the log: it opened the file
 * for appending as the trierarch's stdout and stderr and keeps it open, so a
 * renamed log would take its writes along. The log moves aside as a copy, and
 * the file launchd holds is emptied: appending, its next write starts the new
 * log. The records are written synchronously, so none falls between the copy
 * and the emptying. On Linux the journal caps the log itself.
 */

/** The log's size limit in bytes: the trierarch keeps at most about twice it. */
export const LOG_MAX_BYTES = 1024 * 1024;

/** A lock older than this was left by a writer stopped while moving the log aside. */
const STALE_LOCK_MS = 60 * 1000;

const sizeOf = (file: string): number => statSync(file, { throwIfNoEntry: false })?.size ?? 0;

/**
 * Moves the log aside once it reached its limit. One writer moves it: another
 * finding the lock taken appends on, and the one holding the lock looks at the
 * size again, so a log just moved aside by another is not moved twice.
 */
function moveAsideWhenFull(at: { file: string; maxBytes: number; now: () => Date }): void {
  const { file, maxBytes, now } = at;
  if (sizeOf(file) < maxBytes) {
    return;
  }
  const lock = `${file}.lock`;
  const taken = statSync(lock, { throwIfNoEntry: false });
  if (taken !== undefined && now().getTime() - taken.mtimeMs > STALE_LOCK_MS) {
    rmdirSync(lock);
  }
  try {
    mkdirSync(lock);
  } catch {
    return;
  }
  try {
    if (sizeOf(file) >= maxBytes) {
      copyFileSync(file, `${file}.1`);
      truncateSync(file, 0);
    }
  } finally {
    rmdirSync(lock);
  }
}

/** A stream that writes each record to the log through `stream`, moving the log aside first once it is full. A log it cannot move aside is written on. */
export function cappedLogStream(at: { file: string; stream: LogStream; now: () => Date; maxBytes?: number }): LogStream {
  const { file, stream, now, maxBytes = LOG_MAX_BYTES } = at;
  return {
    isTerminal: stream.isTerminal,
    write: (text) => {
      try {
        moveAsideWhenFull({ file, maxBytes, now });
      } catch {
        // A full disk or a changed permission must not stop the trierarch: the record is written all the same.
      }
      stream.write(text);
    },
  };
}

/** Whether a file descriptor is open on the log file, as the trierarch's stdout is under launchd. */
export function isWritingTo(descriptor: number, file: string): boolean {
  const log = statSync(file, { throwIfNoEntry: false });
  if (log === undefined) {
    return false;
  }
  const open = fstatSync(descriptor);
  return open.dev === log.dev && open.ino === log.ino;
}
