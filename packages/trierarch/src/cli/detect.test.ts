import { describe, expect, it } from 'vitest';

import { CONFIGURATION } from '../../test/support/in-memory.js';
import type { Detected } from '../core/ports.js';
import { describeDetected, detectOptions } from './detect.js';

const AT = new Date('2026-10-08T15:00:00.000Z');

const DETECTED: Detected = {
  'claude-code': {
    version: '2.1.293',
    detectedAt: AT,
    confirmedAt: AT,
    options: { model: { values: { 'claude-opus-5-5': ['--model', 'claude-opus-5-5'], 'claude-sonnet-5-5': ['--model', 'claude-sonnet-5-5'] } }, effort: { values: { low: ['--effort', 'low'], high: ['--effort', 'high'] } } },
  },
  codex: { version: '0.160.1', detectedAt: AT, confirmedAt: AT, options: { model: { values: { 'gpt-6.1-sol': ['-m', 'gpt-6.1-sol'], 'gpt-6-luna': ['-m', 'gpt-6-luna'] }, default: 'gpt-6-luna' } } },
};

describe('aeolus-trierarch detect (#365)', () => {
  it('detects every configured harness again by hand, and gives what it found', async () => {
    const asked: { harnesses: readonly string[]; isForced: boolean }[] = [];
    const configuration = { ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } };

    const report = await detectOptions({
      configuration,
      detect: (at) => {
        asked.push(at);
        return Promise.resolve(DETECTED);
      },
    });

    expect(asked).toEqual([{ harnesses: ['claude-code', 'codex'], isForced: true }]);
    expect(report.harnesses).toEqual({
      'claude-code': { version: '2.1.293', confirmedAt: '2026-10-08T15:00:00.000Z', options: { model: ['claude-opus-5-5', 'claude-sonnet-5-5'], effort: ['low', 'high'] } },
      codex: { version: '0.160.1', confirmedAt: '2026-10-08T15:00:00.000Z', options: { model: ['gpt-6.1-sol', 'gpt-6-luna'] } },
    });
  });

  it('says per harness its version, each option with its values and default, and when its models were last confirmed', () => {
    expect(describeDetected({ harnesses: ['claude-code', 'codex', 'gemini'], detected: { ...DETECTED, 'claude-code': { ...DETECTED['claude-code'], confirmedAt: null, options: {} } } })).toEqual(
      [
        'claude-code 2.1.293: no options detected; no model confirmed',
        'codex 0.160.1: model gpt-6.1-sol, gpt-6-luna (default); models confirmed 2026-10-08T15:00:00.000Z',
        'gemini: nothing detected',
      ].join('\n'),
    );
  });
});
