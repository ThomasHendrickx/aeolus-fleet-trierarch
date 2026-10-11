import { describe, expect, it } from 'vitest';

import { scriptEnvironment } from './script-environment.js';

// A test run inside Claude Code inherits its harness variables and CI does not,
// so a script under test sees only the harness variables its test sets (#717).

/** The environment of a test run started from a Claude Code session that runs the plugin. */
const A_HARNESS_CALLER = { PATH: '/usr/bin:/bin', CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: '/plugin', AEOLUS_HARNESS: 'claude-code', PLUGIN_ROOT: '/plugin' };

describe('scriptEnvironment (#717)', () => {
  it("leaves out the caller's CLAUDECODE, CLAUDE_PLUGIN_ROOT, AEOLUS_HARNESS and PLUGIN_ROOT", () => {
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
