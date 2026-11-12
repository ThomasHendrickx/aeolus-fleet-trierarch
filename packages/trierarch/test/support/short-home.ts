import { mkdtempSync } from 'node:fs';

/**
 * A home folder as short as a person's, under /tmp, so a ship's socket path
 * under its place of ships/ is within the system's limit (104 bytes on macOS),
 * as the test runner's own temporary folder on macOS would not be.
 */
export function aShortHome(prefix: string): string {
  return mkdtempSync(`/tmp/${prefix}-`);
}
