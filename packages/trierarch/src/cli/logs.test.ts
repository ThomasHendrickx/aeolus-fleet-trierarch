import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { followLog, tailLog } from './logs.js';

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-logs-'));
  file = join(folder, 'trierarch.log');
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('aeolus-trierarch logs', () => {
  it('shows the last lines of the log', async () => {
    writeFileSync(file, 'one\ntwo\nthree\nfour\n');

    await expect(tailLog({ file, lines: 2 })).resolves.toEqual(['three', 'four']);
    await expect(tailLog({ file, lines: 10 })).resolves.toEqual(['one', 'two', 'three', 'four']);
  });

  it('shows no lines before the trierarch wrote any', async () => {
    await expect(tailLog({ file, lines: 10 })).resolves.toEqual([]);
  });

  it('follows the log: each line written after it started, whole, until it is stopped', async () => {
    writeFileSync(file, 'before\n');
    const seen: string[] = [];
    const stopping = new AbortController();

    const following = followLog({
      file,
      signal: stopping.signal,
      intervalMs: 5,
      write: (line) => {
        seen.push(line);
        if (line === 'third') {
          stopping.abort();
        }
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    appendFileSync(file, 'first\nsec');
    await new Promise((resolve) => setTimeout(resolve, 30));
    appendFileSync(file, 'ond\nthird\n');
    await following;

    expect(seen).toEqual(['first', 'second', 'third']);
  });

  it('follows a log that does not exist yet', async () => {
    const seen: string[] = [];
    const stopping = new AbortController();

    const following = followLog({
      file,
      signal: stopping.signal,
      intervalMs: 5,
      write: (line) => {
        seen.push(line);
        stopping.abort();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(file, 'started\n');
    await following;

    expect(seen).toEqual(['started']);
  });
});
