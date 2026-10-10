import { describe, expect, it } from 'vitest';

import { CONFIGURATION } from '../../test/support/in-memory.js';
import { describeFlags } from './flags.js';

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
