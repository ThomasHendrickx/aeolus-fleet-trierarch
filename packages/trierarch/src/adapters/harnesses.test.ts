import { describe, expect, it } from 'vitest';

import { CONFIGURATION } from '../../test/support/in-memory.js';
import { createHarnesses, riskyFlagsOf } from './harnesses.js';

const sessions = { start: () => Promise.resolve(), type: () => Promise.resolve(), screen: () => Promise.resolve('') };
const env = { AEOLUS_PLUGIN_ROOT: '/claude-plugin', AEOLUS_CODEX_PLUGIN_ROOT: '/codex-plugin' };

describe('the harnesses a trierarch offers', () => {
  it('has an adapter for each harness the configuration offers, and only those', async () => {
    const both = { ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } };

    const { harnesses } = await createHarnesses({ configuration: both, homeDirectory: '/home/thomas', env, managedSettings: '/home/thomas/managed', detected: () => ({}), sessions });

    expect(Object.keys(harnesses).sort()).toEqual(['claude-code', 'codex']);
  });

  it('looks for the aeolus plugin of Codex only when the configuration offers Codex', async () => {
    const { plugins } = await createHarnesses({ configuration: CONFIGURATION, homeDirectory: '/home/thomas', env: { AEOLUS_PLUGIN_ROOT: '/claude-plugin' }, managedSettings: '/home/thomas/managed', detected: () => ({}), sessions });

    expect(Object.keys(plugins)).toEqual(['claude-code']);
  });

  it("names each configured harness's risky flags, as Thomas decided: skipping permissions in Claude Code, bypassing approvals and the sandbox in Codex (#326)", () => {
    const both = { ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } };

    expect(riskyFlagsOf(both)).toEqual({ 'claude-code': ['--dangerously-skip-permissions'], codex: ['--dangerously-bypass-approvals-and-sandbox'] });
  });

  it('refuses a configured harness it has no adapter for, naming it', async () => {
    const withPi = { ...CONFIGURATION, harnesses: { pi: { flags: [], options: {} } } };

    await expect(createHarnesses({ configuration: withPi, homeDirectory: '/home/thomas', env, managedSettings: '/home/thomas/managed', detected: () => ({}), sessions })).rejects.toThrow('no adapter for the harness pi');
  });
});
