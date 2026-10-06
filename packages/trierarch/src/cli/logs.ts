import { open, readFile, stat } from 'node:fs/promises';

/**
 * `aeolus-trierarch logs`: the last lines of the trierarch's log, and with
 * `--follow` each line written after, until it is stopped. The log is the file
 * the service writes, `~/.aeolus/trierarch/logs/trierarch.log`.
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
