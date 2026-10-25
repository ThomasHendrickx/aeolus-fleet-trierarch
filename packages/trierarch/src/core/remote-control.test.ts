import { describe, expect, it } from 'vitest';

import { CONFIGURATION } from '../../test/support/in-memory.js';
import { withoutRemoteControl } from './remote-control.js';

describe('a configuration without Remote Control (headless H20)', () => {
  it("takes --remote-control out of each harness's flags, with the name given after it or with =, and names the harnesses it was in", () => {
    const configured = {
      ...CONFIGURATION,
      harnesses: {
        'claude-code': { flags: ['--remote-control', 'mine', '--verbose'], options: {} },
        lookout: { flags: ['--remote-control=lookout'], options: {} },
        codex: { flags: ['--dangerously-bypass-approvals-and-sandbox'], options: {} },
      },
    };

    expect(withoutRemoteControl(configured)).toEqual({
      configuration: {
        ...CONFIGURATION,
        harnesses: { 'claude-code': { flags: ['--verbose'], options: {} }, lookout: { flags: [], options: {} }, codex: { flags: ['--dangerously-bypass-approvals-and-sandbox'], options: {} } },
      },
      harnesses: ['claude-code', 'lookout'],
    });
  });

  it('keeps a flag after --remote-control that is no name, and takes it out of the flags of an option value too', () => {
    const configured = { ...CONFIGURATION, harnesses: { 'claude-code': { flags: ['--remote-control', '--verbose'], options: { remote: { values: { on: ['--remote-control'], off: [] }, default: 'off' } } } } };

    expect(withoutRemoteControl(configured)).toEqual({
      configuration: { ...CONFIGURATION, harnesses: { 'claude-code': { flags: ['--verbose'], options: { remote: { values: { on: [], off: [] }, default: 'off' } } } } },
      harnesses: ['claude-code'],
    });
  });

  it('names no harness for a configuration without it, and changes nothing', () => {
    const configured = { ...CONFIGURATION, harnesses: { 'claude-code': { flags: ['--verbose'], options: {} } } };

    expect(withoutRemoteControl(configured)).toEqual({ configuration: configured, harnesses: [] });
  });
});
