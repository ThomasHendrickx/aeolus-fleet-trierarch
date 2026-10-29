import { describe, expect, it } from 'vitest';

import { createCopilotDetector } from './copilot-detector.js';
import type { CommandResult } from './run-command.js';

const NOW = new Date('2026-10-29T15:00:00.000Z');

/** `copilot help config` as Copilot CLI 1.0.105 prints it, cut to the settings around its model list. */
const HELP_CONFIG = `Configuration Settings:

  \`logLevel\`: log level for CLI; defaults to "default". Set to "all" for debug logging.

  \`model\`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.
    - "claude-sonnet-5.5"
    - "claude-opus-5.5"
    - "gpt-6-luna"
    - "mai-code-1.1-flash"

  \`contextTier\`: context window tier for tiered-pricing models (e.g., "default" or "long_context").
    - Can also be set with --context flag (overrides persisted setting)
`;

/** Copilot CLI 1.0.105: `--version` and `help config` as it prints them, or as given; every other call is kept and fails. */
function aCopilot(at: { version?: CommandResult; helpConfig?: CommandResult; settings?: string } = {}) {
  const calls: (readonly string[])[] = [];
  const run = (command: string, options: { args: readonly string[] }): Promise<CommandResult> => {
    expect(command).toBe('copilot');
    calls.push(options.args);
    if (options.args[0] === '--version') {
      return Promise.resolve(at.version ?? { status: 0, stdout: "GitHub Copilot CLI 1.0.105.\nRun 'copilot update' to check for updates.\n", stderr: '' });
    }
    if (options.args.join(' ') === 'help config') {
      return Promise.resolve(at.helpConfig ?? { status: 0, stdout: HELP_CONFIG, stderr: '' });
    }
    return Promise.resolve({ status: 1, stdout: '', stderr: 'not a call detection makes' });
  };
  const detector = createCopilotDetector({ run, readSettings: () => Promise.resolve(at.settings) });
  return { detector, calls };
}

describe('detecting Copilot', () => {
  it('reads its version from the first line --version prints', async () => {
    await expect(aCopilot().detector.version()).resolves.toBe('1.0.105');
  });

  it('has no version when --version fails', async () => {
    await expect(aCopilot({ version: { status: 127, stdout: '', stderr: 'copilot: not found' } }).detector.version()).resolves.toBeUndefined();
  });

  it('declares each model its help names for the model setting, and auto, each with --model', async () => {
    const detected = await aCopilot().detector.detect({ version: '1.0.105', previous: undefined, now: NOW });

    expect(detected?.options.model?.values).toEqual({
      'claude-sonnet-5.5': ['--model', 'claude-sonnet-5.5'],
      'claude-opus-5.5': ['--model', 'claude-opus-5.5'],
      'gpt-6-luna': ['--model', 'gpt-6-luna'],
      'mai-code-1.1-flash': ['--model', 'mai-code-1.1-flash'],
      auto: ['--model', 'auto'],
    });
  });

  it('makes auto the default, as Copilot starts on it, when its settings name no model', async () => {
    const detected = await aCopilot().detector.detect({ version: '1.0.105', previous: undefined, now: NOW });

    expect(detected?.options.model?.default).toBe('auto');
  });

  it('makes the model its settings name the default when it is one it declares', async () => {
    const detected = await aCopilot({ settings: JSON.stringify({ model: 'gpt-6-luna' }) }).detector.detect({ version: '1.0.105', previous: undefined, now: NOW });

    expect(detected?.options.model?.default).toBe('gpt-6-luna');
  });

  it('keeps auto the default when its settings name a model it does not declare', async () => {
    const detected = await aCopilot({ settings: JSON.stringify({ model: 'gpt-retired' }) }).detector.detect({ version: '1.0.105', previous: undefined, now: NOW });

    expect(detected?.options.model?.default).toBe('auto');
  });

  it('confirms no model, so it runs no prompt: every prompt costs a premium request', async () => {
    const copilot = aCopilot();

    const detected = await copilot.detector.detect({ version: '1.0.105', previous: undefined, now: NOW });

    expect({ confirmedAt: detected?.confirmedAt, calls: copilot.calls }).toEqual({ confirmedAt: null, calls: [['help', 'config']] });
  });

  it('declares auto alone, saying why, when its help names no model', async () => {
    const detected = await aCopilot({ helpConfig: { status: 0, stdout: 'Configuration Settings:\n', stderr: '' } }).detector.detect({ version: '1.0.105', previous: undefined, now: NOW });

    expect(detected).toEqual({
      version: '1.0.105',
      detectedAt: NOW,
      confirmedAt: null,
      options: { model: { values: { auto: ['--model', 'auto'] }, default: 'auto' } },
      problem: 'Copilot 1.0.105 names no model in copilot help config, so this machine declares auto only',
    });
  });
});
