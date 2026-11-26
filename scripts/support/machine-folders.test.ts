import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { aShortFolder, SHORT_FOLDER_VARIABLE } from './test-folders.js';

it('makes each contract machine in a different short folder without reusing an existing one', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-folders-'));
  const env = { [SHORT_FOLDER_VARIABLE]: root };
  try {
    const first = aShortFolder(env);
    const marker = join(first, 'left');
    writeFileSync(marker, 'keep');

    const second = aShortFolder(env);

    expect(dirname(first)).toBe(realpathSync(root));
    expect(dirname(second)).toBe(realpathSync(root));
    expect(first).not.toBe(second);
    expect(existsSync(second)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
