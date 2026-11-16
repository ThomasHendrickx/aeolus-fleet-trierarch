import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createCursorDetector } from './cursor-detector.js';
import type { CommandResult } from './run-command.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const MODELS = readFileSync(new URL('../../test/logs/cursor-models.txt', import.meta.url), 'utf8');

function aCursor(at: { version?: CommandResult; models?: CommandResult } = {}) {
  const calls: (readonly string[])[] = [];
  const detector = createCursorDetector({ run: (program, options) => {
    expect(program).toBe('agent');
    calls.push(options.args);
    return Promise.resolve(options.args[0] === '--version'
      ? (at.version ?? { status: 0, stdout: '2026.11.13-eacade1\n', stderr: '' })
      : (at.models ?? { status: 0, stdout: MODELS, stderr: '' }));
  } });
  return { detector, calls };
}

describe('detecting Cursor without a model prompt (CC9)', () => {
  it('reads the captured date-and-build version', async () => {
    await expect(aCursor().detector.version()).resolves.toBe('2026.11.13-eacade1');
  });

  it('has no version when the CLI cannot run', async () => {
    await expect(aCursor({ version: { status: 127, stdout: '', stderr: 'not found' } }).detector.version()).resolves.toBeUndefined();
  });

  it('declares the CLI model ids and auto, using the CLI default', async () => {
    const { detector, calls } = aCursor();
    const result = await detector.detect({ version: '2026.11.13-eacade1', previous: undefined, now: NOW });

    expect(result?.options.model?.values.auto).toEqual(['--model', 'auto']);
    expect(result?.options.model?.values['gpt-5.3-codex']).toEqual(['--model', 'gpt-5.3-codex']);
    expect(result?.options.model?.default).toBe('auto');
    expect(result?.confirmedAt).toBeNull();
    expect(calls).toEqual([['models']]);
  });

  it('uses a named CLI default and ignores malformed ids and unrelated output', async () => {
    const { detector } = aCursor({ models: { status: 0, stdout: 'Available models\n\nauto - Auto\nsonnet - Sonnet (default)\nbad name - Bad\n', stderr: '' } });
    const result = await detector.detect({ version: '2026.11.13-eacade1', previous: undefined, now: NOW });

    expect(result?.options.model).toEqual({ values: { auto: ['--model', 'auto'], sonnet: ['--model', 'sonnet'] }, default: 'sonnet' });
  });

  it('declares auto alone with a problem when model listing fails', async () => {
    const result = await aCursor({ models: { status: 1, stdout: '', stderr: 'not signed in' } }).detector.detect({ version: '2026.11.13-eacade1', previous: undefined, now: NOW });

    expect(result?.options.model).toEqual({ values: { auto: ['--model', 'auto'] }, default: 'auto' });
    expect(result?.problem).toContain('names no model');
  });
});
