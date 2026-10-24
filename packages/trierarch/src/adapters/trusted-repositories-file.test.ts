import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTrustedRepositoriesFile } from './trusted-repositories-file.js';

let folder: string;
let file: string;
let clones: string;
let trusted: string[][];

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-trusted-'));
  file = join(folder, 'trusted-repositories.json');
  clones = join(folder, 'repositories');
  trusted = [];
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const HEMMA = { name: 'hemma', url: 'git@github.com:ThomasHendrickx/hemma.git' };

function opened() {
  return createTrustedRepositoriesFile({
    file,
    clonesRoot: clones,
    trustClones: (paths) => {
      trusted.push([...paths]);
      return Promise.resolve();
    },
  });
}

describe('the trusted repositories file', () => {
  it('holds none before the first list arrives', async () => {
    const repositories = opened();
    await repositories.load();

    expect(repositories.current()).toEqual([]);
  });

  it('keeps the list it accepts, across a restart of the trierarch', async () => {
    await opened().accept([HEMMA]);

    const restarted = opened();
    await restarted.load();

    expect(restarted.current()).toEqual([HEMMA]);
  });

  it('holds the list it accepts at once', async () => {
    const repositories = opened();

    await repositories.accept([HEMMA]);

    expect(repositories.current()).toEqual([HEMMA]);
  });

  it("trusts each one's clone for the harnesses as it accepts the list, so a session may start in it (#381)", async () => {
    await opened().accept([HEMMA, { name: 'skills', url: 'https://github.com/ThomasHendrickx/skills.git' }]);

    expect(trusted).toEqual([[join(clones, 'hemma'), join(clones, 'skills')]]);
  });

  it('places each clone under its root, by name', () => {
    expect(opened().cloneOf('hemma')).toBe(join(clones, 'hemma'));
  });

  it('holds none from a file that does not fit, as one written by hand', async () => {
    writeFileSync(file, '{"repositories":[{"name":"hemma","url":"file:///srv/hemma"}]}');
    const repositories = opened();

    await repositories.load();

    expect(repositories.current()).toEqual([]);
  });
});
