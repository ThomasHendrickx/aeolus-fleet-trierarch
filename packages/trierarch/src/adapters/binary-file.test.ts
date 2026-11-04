import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBinaryFile } from './binary-file.js';

const EXECUTABLE = 0o111;

let folder: string;
let path: string;

beforeEach(() => {
  folder = join(mkdtempSync(join(tmpdir(), 'trierarch-binary-file-')), '.local', 'bin');
  path = join(folder, 'aeolus-trierarch');
});

afterEach(() => {
  rmSync(join(folder, '..', '..'), { recursive: true, force: true });
});

describe('the trierarch binary in ~/.local/bin', () => {
  it('stages the binary beside its place, executable, creating the folder', async () => {
    const file = createBinaryFile({ path, version: '0.18.0' });

    const staged = await file.stage(Buffer.from('the Go trierarch'));

    expect(staged).toBe(join(folder, '.aeolus-trierarch-0.18.0'));
    expect(readFileSync(staged, 'utf8')).toBe('the Go trierarch');
    expect(statSync(staged).mode & EXECUTABLE).toBe(EXECUTABLE);
    expect(existsSync(path)).toBe(false);
  });

  it('places the staged binary, and settling leaves only it', async () => {
    const file = createBinaryFile({ path, version: '0.18.0' });
    await file.stage(Buffer.from('the Go trierarch'));

    await file.place();
    await file.settle();

    expect(readFileSync(path, 'utf8')).toBe('the Go trierarch');
    expect(readdirSync(folder)).toEqual(['aeolus-trierarch']);
  });

  it('puts back the file that was there before', async () => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path, 'an older binary');
    const file = createBinaryFile({ path, version: '0.18.0' });
    await file.stage(Buffer.from('the Go trierarch'));
    await file.place();

    await file.putBack();
    await file.settle();

    expect(readFileSync(path, 'utf8')).toBe('an older binary');
    expect(readdirSync(folder)).toEqual(['aeolus-trierarch']);
  });

  it('puts back no file when there was none before', async () => {
    const file = createBinaryFile({ path, version: '0.18.0' });
    await file.stage(Buffer.from('the Go trierarch'));
    await file.place();

    await file.putBack();
    await file.settle();

    expect(readdirSync(folder)).toEqual([]);
  });

  it('settling a staged binary never placed removes it', async () => {
    const file = createBinaryFile({ path, version: '0.18.0' });
    await file.stage(Buffer.from('the Go trierarch'));

    await file.settle();

    expect(readdirSync(folder)).toEqual([]);
  });
});
