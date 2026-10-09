import type { TrierarchConfiguration } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { modelOptionsIgnored, withDetectedOptions } from './detected-options.js';
import type { Detected } from './ports.js';

const AT = new Date('2026-10-08T15:00:00.000Z');

const operatorEffort = { values: { fast: ['--effort', 'low'] }, default: 'fast' };
const detectedModel = { values: { 'claude-opus-5-5': ['--model', 'claude-opus-5-5'], 'claude-sonnet-5-5': ['--model', 'claude-sonnet-5-5'] } };
const detectedEffort = { values: { low: ['--effort', 'low'], high: ['--effort', 'high'] } };
const codexModel = { values: { 'gpt-6.1-sol': ['-m', 'gpt-6.1-sol'] }, default: 'gpt-6.1-sol' };

const configuration: TrierarchConfiguration = {
  caps: { ships: 4, running: 2 },
  repositories: {},
  folders: {},
  harnesses: { 'claude-code': { flags: ['--remote-control'], options: { effort: operatorEffort } }, codex: { flags: [], options: {} } },
};

const detected: Detected = {
  'claude-code': { version: '2.1.293', detectedAt: AT, confirmedAt: AT, options: { model: detectedModel, effort: detectedEffort } },
  codex: { version: '0.160.1', detectedAt: AT, confirmedAt: AT, options: { model: codexModel } },
  gemini: { version: '1.0.0', detectedAt: AT, confirmedAt: AT, options: { model: { values: { pro: ['--model', 'pro'] } } } },
};

describe('the detected options of a configuration (#365)', () => {
  it("adds each detected option to the harness the operator configured, an option the operator wrote winning whole by its name", () => {
    expect(withDetectedOptions(configuration, detected).harnesses).toEqual({
      'claude-code': { flags: ['--remote-control'], options: { model: detectedModel, effort: operatorEffort } },
      codex: { flags: [], options: { model: codexModel } },
    });
  });

  it('adds no harness the configuration does not offer', () => {
    expect(Object.keys(withDetectedOptions(configuration, detected).harnesses)).toEqual(['claude-code', 'codex']);
  });

  it('leaves the configuration as it is without a detection', () => {
    expect(withDetectedOptions(configuration, {})).toEqual(configuration);
  });
});

describe('model ids from detection only (#382)', () => {
  const operatorModel = { values: { opus: ['--model', 'claude-opus-5-5'] }, default: 'opus' };
  const withOperatorModel: TrierarchConfiguration = {
    ...configuration,
    harnesses: { 'claude-code': { flags: [], options: { model: operatorModel, effort: operatorEffort } }, codex: { flags: [], options: { model: operatorModel } } },
  };

  it('never takes a model option the operator wrote: the detected one stands', () => {
    expect(withDetectedOptions(withOperatorModel, detected).harnesses['claude-code']?.options).toEqual({ model: detectedModel, effort: operatorEffort });
  });

  it('offers no model at all for a harness detection found none for, whatever the configuration writes', () => {
    expect(withDetectedOptions(withOperatorModel, {}).harnesses.codex?.options).toEqual({});
  });

  it('names each harness whose configuration writes a model option, so the operator is told it is ignored', () => {
    expect(modelOptionsIgnored(withOperatorModel)).toEqual(['claude-code', 'codex']);
    expect(modelOptionsIgnored(configuration)).toEqual([]);
  });

  it('leaves out an id the machine refused, the default moving to the first id left', () => {
    const codexModels = { values: { 'gpt-6.1-sol': ['-m', 'gpt-6.1-sol'], 'gpt-5.6-sol': ['-m', 'gpt-5.6-sol'] }, default: 'gpt-6.1-sol' };
    const refusedDefault: Detected = { codex: { version: '0.160.1', detectedAt: AT, confirmedAt: AT, options: { model: codexModels }, refused: [{ id: 'gpt-6.1-sol', at: AT }] } };

    expect(withDetectedOptions(configuration, refusedDefault).harnesses.codex?.options).toEqual({
      model: { values: { 'gpt-5.6-sol': ['-m', 'gpt-5.6-sol'] }, default: 'gpt-5.6-sol' },
    });
  });

  it('offers no model option once every detected id was refused', () => {
    const allRefused: Detected = { codex: { version: '0.160.1', detectedAt: AT, confirmedAt: AT, options: { model: codexModel }, refused: [{ id: 'gpt-6.1-sol', at: AT }] } };

    expect(withDetectedOptions(configuration, allRefused).harnesses.codex?.options).toEqual({});
  });
});

