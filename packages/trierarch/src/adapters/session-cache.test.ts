import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionCache } from './session-cache.js';

let root: string;
const now = new Date('2026-11-19T12:00:00Z');
const old = new Date('2026-11-19T08:00:00Z');
const newer = new Date('2026-11-19T09:00:00Z');
const recent = new Date('2026-11-19T11:30:00Z');

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'session-cache-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function entry(path: string, at: { contents: string; modified: Date }): void {
  const { contents, modified } = at;
  const file = join(root, 'cache', path, 'data');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  utimesSync(file, modified, modified);
  utimesSync(dirname(file), modified, modified);
}

describe('the trierarch session cache', () => {
  it('leaves the cache intact when no size is configured', async () => {
    entry('npm', { contents: 'old', modified: old });
    await createSessionCache({ root: join(root, 'cache') }).trim(now);
    expect(readFileSync(join(root, 'cache', 'npm', 'data'), 'utf8')).toBe('old');
  });

  it('moves the oldest whole units to the trash until within the configured size', async () => {
    entry('xdg/old', { contents: '1234', modified: old });
    entry('npm', { contents: '1234', modified: newer });
    entry('go-mod', { contents: '1234', modified: recent });
    await createSessionCache({ root: join(root, 'cache'), maxBytes: 8 }).trim(now);
    expect([existsSync(join(root, 'cache', 'xdg', 'old')), existsSync(join(root, 'cache', 'npm', 'data')), existsSync(join(root, 'cache', 'go-mod', 'data'))]).toEqual([false, true, true]);
    expect(existsSync(join(root, 'cache', '.trash', `old.${String(now.getTime())}`, 'data'))).toBe(true);
  });

  it('keeps a unit modified within the last hour even above the limit', async () => {
    entry('ms-playwright/browser', { contents: '1234', modified: recent });
    await createSessionCache({ root: join(root, 'cache'), maxBytes: 0 }).trim(now);
    expect(existsSync(join(root, 'cache', 'ms-playwright', 'browser', 'data'))).toBe(true);
  });

  it('uses the newest modification inside a unit to order it', async () => {
    entry('xdg/first', { contents: '1234', modified: old });
    entry('npm', { contents: '1234', modified: newer });
    const nested = join(root, 'cache', 'xdg', 'first', 'nested');
    writeFileSync(nested, '1');
    utimesSync(nested, recent, recent);
    utimesSync(dirname(nested), old, old);
    await createSessionCache({ root: join(root, 'cache'), maxBytes: 5 }).trim(now);
    expect([existsSync(join(root, 'cache', 'xdg', 'first')), existsSync(join(root, 'cache', 'npm'))]).toEqual([true, false]);
  });

  it('checks no more than once an hour', async () => {
    const cache = createSessionCache({ root: join(root, 'cache'), maxBytes: 0 });
    await cache.trim(now);
    entry('go-build', { contents: '1234', modified: old });
    await cache.trim(new Date('2026-11-19T12:59:59Z'));
    expect(existsSync(join(root, 'cache', 'go-build'))).toBe(true);
    await cache.trim(new Date('2026-11-19T13:00:00Z'));
    expect(existsSync(join(root, 'cache', 'go-build'))).toBe(false);
  });
});

 it('checks the configured size again on low disk even within the hour', async () => {
    const cache = createSessionCache({ root: join(root, 'cache'), maxBytes: 0 });
    await cache.trim(now);
    entry('go-build', { contents: '1234', modified: old });
    await cache.trim(new Date('2026-11-19T12:01:00Z'), { isUrgent: true });
    expect(existsSync(join(root, 'cache', 'go-build'))).toBe(false);
  });

it('waits for an ongoing trim before low disk is read again', async () => {
  entry('go-build', { contents: '1234', modified: old });
  const cache = createSessionCache({ root: join(root, 'cache'), maxBytes: 0 });
  const ongoing = cache.trim(now);
  await cache.trim(now, { isUrgent: true });
  const isStillThere = existsSync(join(root, 'cache', 'go-build'));
  await ongoing;
  expect(isStillThere).toBe(false);
});
