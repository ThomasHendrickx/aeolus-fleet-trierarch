import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandResult } from '../adapters/run-command.js';
import { SYSTEMD_UNIT } from '../adapters/service.js';
import { createServiceLog, followLog, tailLog } from './logs.js';

let folder: string;
let file: string;
let calls: string[];

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-logs-'));
  file = join(folder, 'trierarch.log');
  calls = [];
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

const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });

/** The log on a platform, journalctl answering `answer` and streaming `streamed`. */
function logOn(platform: string, at: { answer?: CommandResult; streamed?: readonly string[] } = {}) {
  return createServiceLog({
    platform,
    file,
    exec: (command, args) => {
      calls.push([command, ...args].join(' '));
      return Promise.resolve(at.answer ?? ok());
    },
    stream: (command, options) => {
      calls.push([command, ...options.args].join(' '));
      for (const line of at.streamed ?? []) {
        options.write(line);
      }
      return Promise.resolve();
    },
  });
}

describe("the service's log on Linux, in the journal the systemd user unit writes (#474)", () => {
  it('shows the last lines of the journal of the unit', async () => {
    const log = logOn('linux', { answer: ok('three\nfour\n') });

    await expect(log.tail(2)).resolves.toEqual(['three', 'four']);
    expect(calls).toEqual([`journalctl --user --unit ${SYSTEMD_UNIT} --lines 2 --output cat --quiet --no-pager`]);
  });

  it('shows no lines when the journal holds none', async () => {
    await expect(logOn('linux').tail(10)).resolves.toEqual([]);
  });

  it('says why when journalctl cannot read the journal', async () => {
    const log = logOn('linux', { answer: { status: 1, stdout: '', stderr: 'No journal files were found.\n' } });

    await expect(log.tail(10)).rejects.toThrow('journalctl --user --unit aeolus-trierarch.service failed: No journal files were found.');
  });

  it('follows the journal of the unit from now on, each line as journalctl gives it', async () => {
    const seen: string[] = [];

    await logOn('linux', { streamed: ['first', 'second'] }).follow({ signal: new AbortController().signal, intervalMs: 5, write: (line) => seen.push(line) });

    expect(seen).toEqual(['first', 'second']);
    expect(calls).toEqual([`journalctl --user --unit ${SYSTEMD_UNIT} --follow --lines 0 --output cat --quiet --no-pager`]);
  });

  it('says where it is: the journal of the unit', () => {
    expect(logOn('linux').where).toEqual({ journal: `journalctl --user --unit ${SYSTEMD_UNIT}` });
  });
});

describe("the service's log on macOS, in the file the launchd agent writes", () => {
  it('shows the last lines of the file, running nothing', async () => {
    writeFileSync(file, 'one\ntwo\nthree\n');
    const log = logOn('darwin');

    await expect(log.tail(2)).resolves.toEqual(['two', 'three']);
    expect(log.where).toEqual({ file });
    expect(calls).toEqual([]);
  });
});
