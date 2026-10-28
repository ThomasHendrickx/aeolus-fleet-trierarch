import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKeyFiles } from './key-files.js';

/** A made-up key: no test holds a real one. */
const KEY = 'test-key-not-real';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-keys-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('the key files', () => {
  it('keep a harness key in a file of its own, readable by its user only, in a folder only its user may enter (api keys K5)', async () => {
    const keys = join(folder, 'keys');

    await createKeyFiles(keys).write('claude-code', KEY);

    expect(readFileSync(join(keys, 'claude-code'), 'utf8')).toBe(KEY);
    expect(statSync(join(keys, 'claude-code')).mode & 0o777).toBe(0o600);
    expect(statSync(keys).mode & 0o777).toBe(0o700);
  });

  it('say which harnesses hold a key', async () => {
    const keys = createKeyFiles(join(folder, 'keys'));

    await keys.write('codex', KEY);

    await expect(keys.has('codex')).resolves.toBe(true);
    await expect(keys.has('claude-code')).resolves.toBe(false);
  });

  it('replace a key written before', async () => {
    const keys = createKeyFiles(join(folder, 'keys'));

    await keys.write('codex', 'test-key-old');
    await keys.write('codex', KEY);

    expect(readFileSync(join(folder, 'keys', 'codex'), 'utf8')).toBe(KEY);
  });

  it('remove a key, and answer whether there was one', async () => {
    const keys = createKeyFiles(join(folder, 'keys'));
    await keys.write('codex', KEY);

    await expect(keys.remove('codex')).resolves.toBe(true);
    await expect(keys.remove('codex')).resolves.toBe(false);
    expect(existsSync(join(folder, 'keys', 'codex'))).toBe(false);
  });
});
