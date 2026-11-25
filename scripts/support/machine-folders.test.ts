import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

it('makes each contract machine in a different short folder without reusing an existing one', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-folders-'));
  const program = `
    import { writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    const { aMachine } = await import(${JSON.stringify(fileURLToPath(new URL('../../contract/support/machine.ts', import.meta.url)))});
    const first = await aMachine();
    writeFileSync(join(dirname(first.home), 'left'), 'keep');
    const second = await aMachine();
    console.log(JSON.stringify([dirname(first.home), dirname(second.home)]));
  `;
  try {
    const result = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./source-loader.ts', import.meta.url)), '--input-type=module', '-e', program], {
      env: { ...process.env, TRIERARCH_TEST_SHORT_FOLDER: root, AEOLUS_TRIERARCH_UNDER_TEST: `${process.execPath} --version` }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const folders: unknown = JSON.parse(result.stdout);
    expect(folders).toEqual([expect.any(String), expect.any(String)]);
    if (!Array.isArray(folders) || typeof folders[0] !== 'string' || typeof folders[1] !== 'string') throw new Error('expected two folders');
    expect(dirname(folders[0])).toBe(realpathSync(root));
    expect(dirname(folders[1])).toBe(realpathSync(root));
    expect(folders[0]).not.toBe(folders[1]);
    expect(existsSync(folders[0])).toBe(true);
    expect(existsSync(folders[1])).toBe(true);
    expect(readFileSync(join(folders[0], 'left'), 'utf8')).toBe('keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
