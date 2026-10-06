import { describe, expect, it } from 'vitest';

import { CONFIGURATION } from '../../test/support/in-memory.js';
import { describeFlags, effectiveFlags } from './flags.js';

const claudeCode = CONFIGURATION.harnesses['claude-code'] ?? { flags: [], options: {} };

describe('the flags a launch gets', () => {
  it("are the harness's own, then each option's default when the want picks none", () => {
    expect(effectiveFlags(claudeCode, {})).toEqual(['--remote-control', '--model', 'claude-opus-5-5']);
  });

  it('take the value the want picked by name', () => {
    expect(effectiveFlags(claudeCode, { model: 'sonnet' })).toEqual(['--remote-control', '--model', 'claude-sonnet-5-5']);
  });

  it('takes skip-permissions where the operator put it: no policy', () => {
    const harness = { flags: ['--dangerously-skip-permissions'], options: {} };

    expect(effectiveFlags(harness, {})).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('config check', () => {
  it('prints the effective flags per harness, and each option value with its flags, the default marked', () => {
    expect(describeFlags(CONFIGURATION)).toBe(
      [
        'claude-code: --remote-control --model claude-opus-5-5',
        '  model=opus (default): --model claude-opus-5-5',
        '  model=sonnet: --model claude-sonnet-5-5',
      ].join('\n'),
    );
  });
});
