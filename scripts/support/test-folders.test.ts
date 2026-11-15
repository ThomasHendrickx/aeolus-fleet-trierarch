import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestFolders } from './test-folders.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-16T12:00:00Z');

let outside: string;
let repository: string;
let home: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  outside = mkdtempSync(join(tmpdir(), 'aeolus-test-folders-'));
  repository = join(outside, 'repository');
  home = join(outside, 'home');
  mkdirSync(repository);
  mkdirSync(home);
  env = { TMPDIR: '/original' };
});

afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
});

const start = () => startTestFolders({ repositoryRoot: repository, home, now: NOW, env });

/** A run folder an earlier run left, last touched `hoursAgo` hours before NOW. */
function anEarlierRun(folder: string, hoursAgo: number): string {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'left'), 'x');
  const touched = new Date(NOW.getTime() - hoursAgo * HOUR);
  utimesSync(folder, touched, touched);
  return folder;
}

describe('the folders a test run makes its temporary folders in (#454)', () => {
  it("points TMPDIR at a folder of the repository's cache, outside the operating system's temporary folder", () => {
    start();

    expect(env.TMPDIR?.startsWith(join(repository, 'node_modules', '.cache', 'trierarch-tests'))).toBe(true);
    expect(existsSync(env.TMPDIR ?? '')).toBe(true);
  });

  it('gives a short folder under the home for what needs a short path, such as a socket', () => {
    start();

    const short = env.TRIERARCH_TEST_SHORT_FOLDER ?? '';
    expect(short.startsWith(home)).toBe(true);
    expect(short.slice(join(home, '.cache', 'tt').length + 1).length).toBeLessThanOrEqual(6);
    expect(existsSync(short)).toBe(true);
  });

  it('removes both run folders and puts TMPDIR back when the run ends', () => {
    const end = start();
    const folders = [env.TMPDIR ?? '', env.TRIERARCH_TEST_SHORT_FOLDER ?? ''];

    end();

    expect(folders.map((folder) => existsSync(folder))).toEqual([false, false]);
    expect(env.TMPDIR).toBe('/original');
    expect(env.TRIERARCH_TEST_SHORT_FOLDER).toBeUndefined();
  });

  it('removes the run folders older than 24 hours at its start, a killed run left, and keeps the newer ones', () => {
    const bases = [join(repository, 'node_modules', '.cache', 'trierarch-tests'), join(home, '.cache', 'tt')];
    const old = bases.map((base) => anEarlierRun(join(base, 'killed'), 25));
    const recent = bases.map((base) => anEarlierRun(join(base, 'running'), 23));

    start();

    expect(old.map((folder) => existsSync(folder))).toEqual([false, false]);
    expect(recent.map((folder) => existsSync(folder))).toEqual([true, true]);
  });

  it('shares one run between the projects of a run: a second start reuses the folders and does not remove them', () => {
    const first = start();
    const folder = env.TMPDIR;

    const second = start();
    second();

    expect(env.TMPDIR).toBe(folder);
    expect(existsSync(folder ?? '')).toBe(true);
    first();
    expect(existsSync(folder ?? '')).toBe(false);
  });
});
