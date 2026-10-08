import type { TrierarchConfiguration } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { withDetectedOptions } from './detected-options.js';
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
