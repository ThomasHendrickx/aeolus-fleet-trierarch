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

describe('aeolus_json_string reads a top-level key only (#905)', () => {
  it('ignores a nested key of the same name after the top-level one', () => {
    expect(lib('aeolus_json_string', '{"name":"scout","owner":{"name":"argo"}}', 'name')).toBe('scout');
  });

  it('ignores a nested key of the same name before the top-level one, in an object or an array', () => {
    expect(lib('aeolus_json_string', '{"owner":{"name":"argo"},"crews":[{"name":"mate"}],"name":"scout"}', 'name')).toBe('scout');
  });

  it('gives nothing when the key is only nested', () => {
    expect(lib('aeolus_json_string', '{"owner":{"name":"argo"}}', 'name')).toBe('');
  });

  it('reads past a string value that holds the key and braces, as text', () => {
    expect(lib('aeolus_json_string', '{"note":"{\\"name\\":\\"argo\\"}","name":"scout"}', 'name')).toBe('scout');
  });

  it('reads a key with whitespace and newlines around its colon', () => {
    expect(lib('aeolus_json_string', '{\n  "owner": {"name": "argo"},\n  "name" :\n "scout"\n}', 'name')).toBe('scout');
  });
});
