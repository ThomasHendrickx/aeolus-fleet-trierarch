import { describe, expect, it } from 'vitest';

import { createCodexDetector } from './codex-detector.js';
import type { CommandResult } from './run-command.js';

const NOW = new Date('2026-10-08T15:00:00.000Z');

/** `codex debug models --bundled` as codex-cli 0.160.1 prints it, cut to what detection reads. */
const CATALOG = JSON.stringify({
  models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
    { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'gpt-reserve', display_name: 'Reserve', visibility: 'hide', default_reasoning_level: 'low', supported_reasoning_levels: [] },
  ],
});

function aCodex(at: { catalog?: CommandResult; config?: string } = {}) {
  const run = (command: string, options: { args: readonly string[] }): Promise<CommandResult> => {
    expect(command).toBe('codex');
    if (options.args[0] === '--version') {
      return Promise.resolve({ status: 0, stdout: 'codex-cli 0.160.1\n', stderr: '' });
    }
    expect(options.args).toEqual(['debug', 'models', '--bundled']);
    return Promise.resolve(at.catalog ?? { status: 0, stdout: CATALOG, stderr: '' });
  };
  return createCodexDetector({ run, readConfig: () => Promise.resolve(at.config) });
}

const MODEL_VALUES = { 'gpt-6.1-sol': ['-m', 'gpt-6.1-sol'], 'gpt-6-luna': ['-m', 'gpt-6-luna'] };

describe('detecting Codex (#365)', () => {
  it('reads its version from --version', async () => {
    await expect(aCodex().version()).resolves.toBe('0.160.1');
  });

  it("declares the catalog's visible models with -m, the user's configured model as the default, and no effort", async () => {
    const detected = await aCodex({ config: 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n' }).detect({ version: '0.160.1', previous: undefined, now: NOW });

    expect(detected).toEqual({ version: '0.160.1', detectedAt: NOW, confirmedAt: NOW, options: { model: { values: MODEL_VALUES, default: 'gpt-6-luna' } } });
  });

  it("takes the catalog's first visible model as the default when the configured one is not visible, or none is configured", async () => {
    const hidden = await aCodex({ config: 'model = "gpt-reserve"\n' }).detect({ version: '0.160.1', previous: undefined, now: NOW });
    const none = await aCodex().detect({ version: '0.160.1', previous: undefined, now: NOW });

    expect(hidden?.options.model?.default).toBe('gpt-6.1-sol');
    expect(none?.options.model?.default).toBe('gpt-6.1-sol');
  });

  it('reads the model of the top level only, not of a profile', async () => {
    const detected = await aCodex({ config: '[profiles.fast]\nmodel = "gpt-6-luna"\n' }).detect({ version: '0.160.1', previous: undefined, now: NOW });

    expect(detected?.options.model?.default).toBe('gpt-6.1-sol');
  });

  it('gives nothing to detect when the catalog does not come, or lists no visible model', async () => {
    await expect(aCodex({ catalog: { status: 1, stdout: '', stderr: 'unknown command' } }).detect({ version: '0.160.1', previous: undefined, now: NOW })).resolves.toBeUndefined();
    await expect(aCodex({ catalog: { status: 0, stdout: JSON.stringify({ models: [] }), stderr: '' } }).detect({ version: '0.160.1', previous: undefined, now: NOW })).resolves.toBeUndefined();
  });
});
