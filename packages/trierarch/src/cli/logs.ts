import { open, readFile, stat } from 'node:fs/promises';

import { SYSTEMD_UNIT, type Exec } from '../adapters/service.js';

/**
 * `aeolus-trierarch logs`: the last lines of the trierarch's log, and with
 * `--follow` each line written after, until it is stopped. The log is where
 * the service writes it: `~/.aeolus/trierarch/logs/trierarch.log` on macOS,
 * the journal on Linux.
 */

export async function tailLog(at: { file: string; lines: number }): Promise<string[]> {
  const text = await readFile(at.file, 'utf8').catch(() => '');
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.slice(-at.lines);
}

/** Writes each whole line added to the log after it starts, checking every `intervalMs`, until `signal` aborts. */
export async function followLog(at: { file: string; signal: AbortSignal; intervalMs: number; write: (line: string) => void }): Promise<void> {
  const { file, signal, intervalMs, write } = at;
  let offset = (await stat(file).catch(() => undefined))?.size ?? 0;
  let partial = '';
  // Asked afresh each time: a write may stop it.
  const isStopped = (): boolean => signal.aborted;
  while (!isStopped()) {
    const size = (await stat(file).catch(() => undefined))?.size ?? 0;
    // A log written anew from the start: follow it from there.
    if (size < offset) {
      offset = 0;
      partial = '';
    }
    if (size > offset) {
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(size - offset);
        await handle.read(buffer, 0, buffer.length, offset);
        offset = size;
        const lines = (partial + buffer.toString('utf8')).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) {
          if (isStopped()) {
            return;
          }
          write(line);
        }
      } finally {
        await handle.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * The trierarch's log where its service writes it: the file the launchd agent
 * writes on macOS (and wherever no service of ours runs it), the journal of
 * the systemd user unit on Linux, read through `journalctl` (#474).
 */
export interface ServiceLog {
  /** Where the log is: its file, or the command that reads the journal. */
  readonly where: { readonly file: string } | { readonly journal: string };
  /** The last `lines` lines. */
  tail(lines: number): Promise<string[]>;
  /** Writes each line added after it starts, until `signal` aborts. */
  follow(at: { signal: AbortSignal; intervalMs: number; write: (line: string) => void }): Promise<void>;
}

/** Runs a program until it ends or is stopped, writing each line it prints. */
export type Stream = (command: string, options: { args: readonly string[]; signal: AbortSignal; write: (line: string) => void }) => Promise<void>;

export function createServiceLog(at: { platform: string; file: string; exec: Exec; stream: Stream }): ServiceLog {
  const { platform, file, exec, stream } = at;
  if (platform !== 'linux') {
    return {
      where: { file },
      tail: (lines) => tailLog({ file, lines }),
      follow: (following) => followLog({ file, ...following }),
    };
  }
  const unit = ['--user', '--unit', SYSTEMD_UNIT];
  // Each record as the trierarch wrote it, with no journal header or notices.
  const plain = ['--output', 'cat', '--quiet', '--no-pager'];
  return {
    where: { journal: ['journalctl', ...unit].join(' ') },
    tail: async (lines) => {
      const result = await exec('journalctl', [...unit, '--lines', String(lines), ...plain]);
      if (result.status !== 0) {
        throw new Error(`journalctl ${unit.join(' ')} failed: ${result.stderr.trim()}`);
      }
      const read = result.stdout.split('\n');
      if (read.at(-1) === '') {
        read.pop();
      }
      return read;
    },
    follow: ({ signal, write }) => stream('journalctl', { args: [...unit, '--follow', '--lines', '0', ...plain], signal, write }),
  };
}
