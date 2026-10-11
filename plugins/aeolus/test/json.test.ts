import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scriptEnvironment } from './script-environment.js';

// aeolus-lib.sh reads a hook payload's string fields with aeolus_json_string
// and writes JSON with aeolus_json_escape: what one escapes, the other undoes.

const LIB = join(fileURLToPath(new URL('../scripts/', import.meta.url)), 'aeolus-lib.sh');

/** Calls one aeolus-lib.sh function with its arguments, as a script that sources the lib does. */
function lib(fn: string, ...args: string[]): string {
  const result = spawnSync('bash', ['-c', `source "$1"; shift; "$@"`, 'bash', LIB, fn, ...args], { encoding: 'utf8', env: scriptEnvironment() });
  expect(result.stderr).toBe('');
  return result.stdout;
}

/** A hook payload with the field cwd, stated with the given JSON string contents. */
const aPayload = (cwd: string) => `{"session_id":"ses_1","cwd":"${cwd}","source":"startup"}`;

describe('aeolus_json_string (#706)', () => {
  it('gives back every value aeolus_json_escape escaped: quotes, backslashes, tabs, newlines and control characters', () => {
    const value = 'C:\\the "lab"\\box\tby\rthe\ndoor\u0001\u001f/end';

    expect(lib('aeolus_json_string', aPayload(lib('aeolus_json_escape', value)), 'cwd')).toBe(value);
  });

  it('undoes an escaped slash', () => {
    expect(lib('aeolus_json_string', aPayload('\\/home\\/thomas'), 'cwd')).toBe('/home/thomas');
  });

  it('undoes a \\u escape of a control character, a non-ASCII character and a surrogate pair', () => {
    expect(lib('aeolus_json_string', aPayload('a\\u0009b\\u00e9c\\u20acd\\ud83d\\ude80e\\u00E9'), 'cwd')).toBe('a\tbéc€d🚀eé');
  });

  it('undoes an escaped backslash before the letter of an escape as a backslash and that letter', () => {
    expect(lib('aeolus_json_string', aPayload('a\\\\nb\\\\u0041c'), 'cwd')).toBe('a\\nb\\u0041c');
  });
});
