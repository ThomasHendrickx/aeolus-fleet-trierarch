import { describe, expect, it } from 'vitest';

import { CONFIGURATION } from '../../test/support/in-memory.js';
import { effectiveFlags } from './effective-flags.js';

const claudeCode = CONFIGURATION.harnesses['claude-code'] ?? { flags: [], options: {} };

describe('the flags a launch gets', () => {
  it("are the harness's own, then each option's default when the settings pick none", () => {
    expect(effectiveFlags(claudeCode, {})).toEqual(['--remote-control', '--model', 'claude-opus-5-5']);
  });

  it('take the value the settings picked by name', () => {
    expect(effectiveFlags(claudeCode, { model: 'sonnet' })).toEqual(['--remote-control', '--model', 'claude-sonnet-5-5']);
  });

  it('takes skip-permissions where the operator put it: no policy', () => {
    const harness = { flags: ['--dangerously-skip-permissions'], options: {} };

    expect(effectiveFlags(harness, {})).toEqual(['--dangerously-skip-permissions']);
  });
});
