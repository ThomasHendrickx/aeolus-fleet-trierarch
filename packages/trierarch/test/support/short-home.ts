import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A home folder as short as a person's, in the test run's short folder (under
 * the real home, not /tmp: the run removes it), so a ship's socket path under
 * its place of ships/ is within the system's limit (104 bytes on macOS), as
 * the test runner's own temporary folder is not.
 */
export function aShortHome(prefix: string): string {
  const short = process.env.TRIERARCH_TEST_SHORT_FOLDER;
  if (short === undefined) {
    throw new Error('no short test folder: run the test through Vitest, whose global setup makes it');
  }
  return mkdtempSync(join(short, `${prefix}-`));
}
