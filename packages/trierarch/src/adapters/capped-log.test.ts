import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cappedLogStream, isWritingTo } from './capped-log.js';

const MIB = 1024 * 1024;
const NOW = new Date('2026-10-11T12:00:00.000Z');
const RECORD = '{"time":"2026-10-11T12:00:00.000Z","level":"info","message":"aeolus-trierarch runs"}\n';

let logs: string;
let descriptors: number[];

beforeEach(() => {
  logs = mkdtempSync(join(tmpdir(), 'trierarch-capped-log-'));
  descriptors = [];
});

afterEach(() => {
  for (const descriptor of descriptors) {
    closeSync(descriptor);
  }
  rmSync(logs, { recursive: true, force: true });
});

const log = () => join(logs, 'trierarch.log');
const previous = () => join(logs, 'trierarch.log.1');
const read = (file: string) => (statSync(file, { throwIfNoEntry: false }) ? readFileSync(file, 'utf8') : undefined);

/** A log of exactly this many bytes of filler lines. */
function aLogOf(bytes: number, marker = 'x'): string {
  const line = `${marker.repeat(99)}\n`;
  const content = line.repeat(Math.floor(bytes / line.length)) + marker.repeat(bytes % line.length);
  writeFileSync(log(), content);
  return content;
}

/** The log opened for appending, as launchd opens the agent's StandardOutPath, and kept open. */
function openedAsLaunchdDoes(): number {
  const descriptor = openSync(log(), 'a');
  descriptors.push(descriptor);
  return descriptor;
}

/** A stream writing the trierarch's records to the log through an open file, as its stdout under launchd does. */
function aStream(options: { maxBytes?: number; now?: () => Date } = {}) {
  const descriptor = openedAsLaunchdDoes();
  return cappedLogStream({
    file: log(),
    stream: { write: (text) => writeSync(descriptor, text), isTerminal: false },
    now: options.now ?? (() => NOW),
    ...(options.maxBytes !== undefined && { maxBytes: options.maxBytes }),
  });
}

describe("the trierarch's log file is capped: at its size limit it moves aside as trierarch.log.1 and a new log starts", () => {
  it('moves a log that reached the limit aside before the next record, which starts the new log in the same open file', () => {
    const older = aLogOf(1000);
    const stream = aStream({ maxBytes: 1000 });

    stream.write(RECORD);

    expect(read(previous())).toBe(older);
    expect(read(log())).toBe(RECORD);
  });

  it('keeps appending to a log one byte under the limit', () => {
    const older = aLogOf(999);
    const stream = aStream({ maxBytes: 1000 });

    stream.write(RECORD);

    expect(read(previous())).toBeUndefined();
    expect(read(log())).toBe(older + RECORD);
  });

  it('keeps one previous log: a second move aside replaces the first', () => {
    aLogOf(1000, 'a');
    const stream = aStream({ maxBytes: 1000 });
    stream.write(RECORD);
    const second = aLogOf(1000, 'b');

    stream.write(RECORD);

    expect(read(previous())).toBe(second);
    expect(readdirSync(logs).sort()).toEqual(['trierarch.log', 'trierarch.log.1']);
  });

  it('caps the log at 1 MiB by default', () => {
    aLogOf(MIB);
    const stream = aStream();

    stream.write(RECORD);

    expect(statSync(previous()).size).toBe(MIB);
    expect(read(log())).toBe(RECORD);
  });

  it('keeps appending to a log one byte under 1 MiB by default', () => {
    aLogOf(MIB - 1);
    const stream = aStream();

    stream.write(RECORD);

    expect(read(previous())).toBeUndefined();
    expect(statSync(log()).size).toBe(MIB - 1 + RECORD.length);
  });

  it('appends on without moving the log aside while another writer holds the lock', () => {
    const older = aLogOf(1000);
    mkdirSync(`${log()}.lock`);
    const stream = aStream({ maxBytes: 1000 });

    stream.write(RECORD);

    expect(read(previous())).toBeUndefined();
    expect(read(log())).toBe(older + RECORD);
  });

  it('clears a lock older than a minute, left by a writer stopped while moving the log, and moves it aside', () => {
    const older = aLogOf(1000);
    mkdirSync(`${log()}.lock`);
    const twoMinutesAgo = new Date(NOW.getTime() - 2 * 60 * 1000);
    utimesSync(`${log()}.lock`, twoMinutesAgo, twoMinutesAgo);
    const stream = aStream({ maxBytes: 1000 });

    stream.write(RECORD);

    expect(read(previous())).toBe(older);
    expect(read(log())).toBe(RECORD);
    expect(readdirSync(logs).sort()).toEqual(['trierarch.log', 'trierarch.log.1']);
  });

  it('keeps a lock taken within the last minute', () => {
    aLogOf(1000);
    mkdirSync(`${log()}.lock`);
    const halfAMinuteAgo = new Date(NOW.getTime() - 30 * 1000);
    utimesSync(`${log()}.lock`, halfAMinuteAgo, halfAMinuteAgo);
    const stream = aStream({ maxBytes: 1000 });

    stream.write(RECORD);

    expect(read(previous())).toBeUndefined();
  });

  it('writes the record where no log file is yet', () => {
    const written: string[] = [];
    const stream = cappedLogStream({ file: log(), stream: { write: (text) => written.push(text), isTerminal: false }, now: () => NOW });

    stream.write(RECORD);

    expect(written).toEqual([RECORD]);
    expect(read(previous())).toBeUndefined();
  });
});

describe('whether a stream writes the log file', () => {
  it('says yes for a file descriptor open on the log, as stdout under launchd is', () => {
    writeFileSync(log(), '');

    expect(isWritingTo(openedAsLaunchdDoes(), log())).toBe(true);
  });

  it('says no for one open on another file, or where no log file is', () => {
    const elsewhere = join(logs, 'elsewhere.log');
    writeFileSync(elsewhere, '');
    const descriptor = openSync(elsewhere, 'a');
    descriptors.push(descriptor);

    expect(isWritingTo(descriptor, log())).toBe(false);
  });
});
