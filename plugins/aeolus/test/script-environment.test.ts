import { describe, expect, it } from 'vitest';

import { scriptEnvironment } from './script-environment.js';

// A test run inside a crewed session inherits its harness and crew variables and
// CI does not, so a script under test sees only the ones its test sets (#717, #726).

/** The environment of a test run started from a session the trierarch launched to crew a ship with the plugin. */
const A_HARNESS_CALLER = {
  PATH: '/usr/bin:/bin',
  CLAUDECODE: '1',
  CLAUDE_PLUGIN_ROOT: '/plugin',
  CLAUDE_PLUGIN_DATA: '/plugin-data',
  CLAUDE_PROJECT_DIR: '/crewed-folder',
  CLAUDE_ENV_FILE: '/session.env',
  AEOLUS_HARNESS: 'claude-code',
  PLUGIN_ROOT: '/plugin',
  PLUGIN_DATA: '/plugin-data',
  AEOLUS_FOLDER: '/crewed-folder',
  AEOLUS_DATA: '/plugin-data',
  AEOLUS_LAUNCH: 'lnc-2026-10-12T05:00:00.000Z',
};

describe('scriptEnvironment (#717, #726, #752)', () => {
  it("leaves out every harness and crew variable of the caller's that the scripts read", () => {
    expect(scriptEnvironment({}, A_HARNESS_CALLER)).toEqual({ PATH: '/usr/bin:/bin' });
  });

  it('sets the harness variables a test names', () => {
    expect(scriptEnvironment({ CLAUDECODE: '1', AEOLUS_HARNESS: 'codex' }, A_HARNESS_CALLER)).toEqual({ PATH: '/usr/bin:/bin', CLAUDECODE: '1', AEOLUS_HARNESS: 'codex' });
  });

  it("keeps the caller's other variables unless a test sets them", () => {
    expect(scriptEnvironment({ HOME: '/home/scout' }, { ...A_HARNESS_CALLER, HOME: '/home/thomas', LANG: 'C' })).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/scout', LANG: 'C' });
  });

  it("starts from this process's environment when no caller is given", () => {
    expect(scriptEnvironment({}).PATH).toBe(process.env.PATH);
  });
});
