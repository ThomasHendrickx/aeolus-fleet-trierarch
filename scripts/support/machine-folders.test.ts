import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

it('makes a contract machine in a new short folder when a random name already exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-folders-'));
  const occupied = join(root, '0000');
  mkdirSync(occupied);
  writeFileSync(join(occupied, 'left'), 'keep');
  // Fake only the operating system's randomness, in a child so other tests keep theirs.
  const program = `
    import crypto from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    let calls = 0;
    crypto.randomBytes = () => Buffer.from(calls++ === 0 ? '0000' : '0001', 'hex');
    syncBuiltinESMExports();
    const { aMachine } = await import(${JSON.stringify(fileURLToPath(new URL('../../contract/support/machine.ts', import.meta.url)))});
    const machine = await aMachine();
    console.log(machine.home);
  `;
  try {
    const result = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./source-loader.ts', import.meta.url)), '--input-type=module', '-e', program], {
      env: { ...process.env, TRIERARCH_TEST_SHORT_FOLDER: root, AEOLUS_TRIERARCH_UNDER_TEST: "/bin/true" }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(result.stdout.trim())).toBe(true);
    expect(readFileSync(join(occupied, 'left'), 'utf8')).toBe('keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
