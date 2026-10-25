import { open } from 'node:fs/promises';

/** The lines a file gained since the last read, each written whole; `isFromStart` when the file was read from its start, as on the first read or after it shrank. */
export interface AppendedLines {
  readonly lines: readonly string[];
  readonly isFromStart: boolean;
}

/**
 * Reads the lines a growing file appended since its last read (#353), so a
 * transcript of many megabytes is not read whole every few minutes. A line
 * not ended yet waits for the next read. A file that shrank is read again
 * from its start.
 */
export function createAppendedLines(): { read(path: string): Promise<AppendedLines> } {
  const offsets = new Map<string, number>();
  return {
    read: async (path) => {
      const file = await open(path, 'r');
      try {
        const { size } = await file.stat();
        const known = offsets.get(path) ?? 0;
        const start = known > size ? 0 : known;
        const buffer = Buffer.alloc(size - start);
        await file.read(buffer, 0, buffer.length, start);
        const end = buffer.lastIndexOf('\n');
        offsets.set(path, start + end + 1);
        const text = end < 0 ? '' : buffer.subarray(0, end).toString('utf8');
        return { lines: text === '' ? [] : text.split('\n'), isFromStart: start === 0 };
      } finally {
        await file.close();
      }
    },
  };
}
