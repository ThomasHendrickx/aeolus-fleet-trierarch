import { describe, expect, it } from 'vitest';

import type { DetectedHarness } from '../core/ports.js';
import { CLAUDE_CODE_KNOWN_MODELS, createClaudeCodeDetector } from './claude-code-detector.js';
import type { CommandResult } from './run-command.js';

const BEFORE = new Date('2026-10-01T09:00:00.000Z');
const NOW = new Date('2026-10-08T15:00:00.000Z');
const NEUTRAL = '/tmp/trierarch-probe-x1';

const HELP = [
  'Usage: claude [options] [command] [prompt]',
  "  --model <model>                   Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.",
  '  --effort <level>                  Effort level for the current session (low, medium, high, xhigh, max)',
].join('\n');

const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: '' });
const failed = (stderr: string): CommandResult => ({ status: 1, stdout: '', stderr });

/** Claude Code 2.1.293 as the mac mini runs it: each id in `known` answers its probe, `refused` ones are unrecognized, others fail otherwise. */
function aClaude(at: { known?: readonly string[]; refused?: readonly string[]; help?: string } = {}) {
  const calls: { args: readonly string[]; cwd: string | undefined }[] = [];
  const run = (command: string, options: { args: readonly string[]; cwd?: string }): Promise<CommandResult> => {
    calls.push({ args: options.args, cwd: options.cwd });
    expect(command).toBe('claude');
    const [first] = options.args;
    if (first === '--version') {
      return Promise.resolve(ok('2.1.293 (Claude Code)\n'));
    }
    if (first === '--help') {
      return Promise.resolve(ok(at.help ?? HELP));
    }
    const model = options.args[options.args.indexOf('--model') + 1] ?? '';
    if (at.refused?.includes(model) === true) {
      return Promise.resolve(failed(`[claude-code:unrecognized_model] {"model":"${model}"}`));
    }
    if ((at.known ?? CLAUDE_CODE_KNOWN_MODELS).includes(model)) {
      return Promise.resolve(ok(JSON.stringify({ type: 'result', result: 'OK', modelUsage: { [model]: { inputTokens: 9 } } })));
    }
    return Promise.resolve(failed('API Error: Connection error.'));
  };
  return { calls, detector: createClaudeCodeDetector({ run, neutralFolder: () => Promise.resolve(NEUTRAL) }) };
}

const modelOption = (ids: readonly string[]) => ({ values: Object.fromEntries(ids.map((id) => [id, ['--model', id]])) });
const EFFORT = { values: { low: ['--effort', 'low'], medium: ['--effort', 'medium'], high: ['--effort', 'high'], xhigh: ['--effort', 'xhigh'], max: ['--effort', 'max'] } };

describe('detecting Claude Code (#365)', () => {
  it('reads its version from --version', async () => {
    await expect(aClaude().detector.version()).resolves.toBe('2.1.293');
  });

  it('ships the five ids the mac mini runs as the ids it probes', () => {
    expect(CLAUDE_CODE_KNOWN_MODELS).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']);
  });

  it('declares each shipped id its probe confirms as a model, with --model and no default, and the effort levels --help gives, with --effort and no default', async () => {
    const detected = await aClaude().detector.detect({ version: '2.1.293', previous: undefined, now: NOW });

    expect(detected).toEqual({ version: '2.1.293', detectedAt: NOW, confirmedAt: NOW, options: { model: modelOption(CLAUDE_CODE_KNOWN_MODELS), effort: EFFORT } });
  });

  it('probes each id once, from the neutral folder, with one short print-mode turn', async () => {
    const claude = aClaude();

    await claude.detector.detect({ version: '2.1.293', previous: undefined, now: NOW });

    expect(claude.calls.filter((call) => call.args[0] === '-p')).toEqual(
      CLAUDE_CODE_KNOWN_MODELS.map((id) => ({ args: ['-p', '--model', id, '--max-turns', '1', '--output-format', 'json', 'Reply OK'], cwd: NEUTRAL })),
    );
  });

  it('leaves out an id the CLI refuses as unrecognized', async () => {
    const detected = await aClaude({ refused: ['claude-sonnet-5'] }).detector.detect({ version: '2.1.293', previous: undefined, now: NOW });

    expect(Object.keys(detected?.options.model?.values ?? {})).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']);
  });

  it('leaves out an id whose probe neither confirms nor refuses it, and declares no model when none is confirmed', async () => {
    const detected = await aClaude({ known: [] }).detector.detect({ version: '2.1.293', previous: undefined, now: NOW });

    expect(detected).toEqual({ version: '2.1.293', detectedAt: NOW, confirmedAt: null, options: { effort: EFFORT } });
  });

  it('keeps an id confirmed before at the same version when its probe now neither confirms nor refuses it, and when it was confirmed', async () => {
    const previous: DetectedHarness = { version: '2.1.293', detectedAt: BEFORE, confirmedAt: BEFORE, options: { model: modelOption(['claude-opus-5-5', 'claude-sonnet-5']) } };

    const detected = await aClaude({ known: [], refused: ['claude-sonnet-5'] }).detector.detect({ version: '2.1.293', previous, now: NOW });

    expect(detected?.options.model).toEqual(modelOption(['claude-opus-5-5']));
    expect(detected?.confirmedAt).toEqual(BEFORE);
  });

  it('keeps no id confirmed at another version', async () => {
    const previous: DetectedHarness = { version: '2.1.200', detectedAt: BEFORE, confirmedAt: BEFORE, options: { model: modelOption(['claude-opus-5-5']) } };

    const detected = await aClaude({ known: [] }).detector.detect({ version: '2.1.293', previous, now: NOW });

    expect(detected?.options.model).toBeUndefined();
    expect(detected?.confirmedAt).toBeNull();
  });

  it('declares no effort when --help names no levels', async () => {
    const detected = await aClaude({ help: 'Usage: claude [options]' }).detector.detect({ version: '2.1.293', previous: undefined, now: NOW });

    expect(detected?.options.effort).toBeUndefined();
  });
});
