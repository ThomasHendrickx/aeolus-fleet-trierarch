import { describe, expect, it } from 'vitest';

import type { DetectedHarness } from '../core/ports.js';
import { CLAUDE_CODE_PROBE_TIMEOUT_MS, createClaudeCodeDetector } from './claude-code-detector.js';
import type { CommandResult } from './run-command.js';

const BEFORE = new Date('2026-10-01T09:00:00.000Z');
const NOW = new Date('2026-10-08T15:00:00.000Z');
const NEUTRAL = '/tmp/trierarch-probe-x1';

const HELP = [
  'Usage: claude [options] [command] [prompt]',
  "  --model <model>                   Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.",
  '  --effort <level>                  Effort level for the current session (low, medium, high, xhigh, max)',
].join('\n');

/** `claude --help` of Claude Code 2.1.295 as the mac mini prints it, cut to its two options: each description wraps over several lines (#383). */
const WRAPPED_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  --effort <level>                      Effort level for the current session',
  '                                        (low, medium, high, xhigh, max)',
  '  --environment <environment_id>        Create a new cloud session that runs on',
  '                                        the given self-hosted environment',
  '                                        (ccpool_...).',
  '  --model <model>                       Model for the current session. Provide',
  '                                        an alias for the latest model (e.g.',
  "                                        'fable', 'opus', or 'sonnet') or a",
  "                                        model's full name.",
  '  -n, --name <name>                     Set a display name for this session',
].join('\n');

/** What each alias resolves to on Claude Code 2.1.293. */
const RESOLVES: Readonly<Record<string, string>> = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' };

const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: '' });
const failed = (stderr: string): CommandResult => ({ status: 1, stdout: '', stderr });

/**
 * Claude Code 2.1.293 as the mac mini runs it: an alias it `resolves` answers
 * its probe with the exact id in modelUsage (beside `helper` when set), a
 * `refused` one is unrecognized, any other fails otherwise.
 */
function aClaude(at: { resolves?: Readonly<Record<string, string>>; refused?: readonly string[]; help?: string; helper?: string } = {}) {
  const calls: { args: readonly string[]; cwd: string | undefined; timeoutMs: number | undefined }[] = [];
  const run = (command: string, options: { args: readonly string[]; cwd?: string; timeoutMs?: number }): Promise<CommandResult> => {
    calls.push({ args: options.args, cwd: options.cwd, timeoutMs: options.timeoutMs });
    expect(command).toBe('claude');
    const [first] = options.args;
    if (first === '--version') {
      return Promise.resolve(ok('2.1.293 (Claude Code)\n'));
    }
    if (first === '--help') {
      return Promise.resolve(ok(at.help ?? HELP));
    }
    const alias = options.args[options.args.indexOf('--model') + 1] ?? '';
    if (at.refused?.includes(alias) === true) {
      return Promise.resolve(failed(`[claude-code:unrecognized_model] {"model":"${alias}"}`));
    }
    const id = (at.resolves ?? RESOLVES)[alias];
    if (id !== undefined) {
      const modelUsage = { ...(at.helper !== undefined && { [at.helper]: { inputTokens: 3 } }), [id]: { inputTokens: 9 } };
      return Promise.resolve(ok(JSON.stringify({ type: 'result', result: 'OK', modelUsage })));
    }
    return Promise.resolve(failed('API Error: Connection error.'));
  };
  return { calls, detector: createClaudeCodeDetector({ run, neutralFolder: () => Promise.resolve(NEUTRAL) }) };
}

const modelOption = (ids: readonly string[]) => ({ values: Object.fromEntries(ids.map((id) => [id, ['--model', id]])) });
const EFFORT = { values: { low: ['--effort', 'low'], medium: ['--effort', 'medium'], high: ['--effort', 'high'], xhigh: ['--effort', 'xhigh'], max: ['--effort', 'max'] } };
const ALL_IDS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'];

describe('detecting Claude Code (#365)', () => {
  it("reads the aliases and the effort levels from --help whose descriptions wrap over several lines (#383)", async () => {
    const detected = await aClaude({ help: WRAPPED_HELP }).detector.detect({ version: '2.1.295', previous: undefined, now: NOW });

    expect(detected?.options).toEqual({ model: modelOption(ALL_IDS), effort: EFFORT });
  });

  it('reads its version from --version', async () => {
    await expect(aClaude().detector.version()).resolves.toBe('2.1.293');
  });

  it('gives a probe a minute at most, so a CLI that hangs never holds up the trierarch for long', () => {
    expect(CLAUDE_CODE_PROBE_TIMEOUT_MS).toBe(60_000);
  });

  it('probes each alias --help names once, from the neutral folder, with one short print-mode turn within a time limit', async () => {
    const claude = aClaude();

    await claude.detector.detect({ version: '2.1.293', previous: undefined, now: NOW });

    expect(claude.calls.filter((call) => call.args[0] === '-p')).toEqual(
      ['fable', 'opus', 'sonnet'].map((alias) => ({ args: ['-p', '--model', alias, '--max-turns', '1', '--output-format', 'json', 'Reply OK'], cwd: NEUTRAL, timeoutMs: CLAUDE_CODE_PROBE_TIMEOUT_MS })),
    );
  });

  it("declares the exact id each alias resolves to, read from its probe's modelUsage, with --model and no default, and the effort levels --help gives, with --effort and no default", async () => {
    const detected = await aClaude().detector.detect({ version: '2.1.293', previous: undefined, now: NOW });

    expect(detected).toEqual({ version: '2.1.293', detectedAt: NOW, confirmedAt: NOW, options: { model: modelOption(ALL_IDS), effort: EFFORT } });
  });

  it('takes the id that names its alias when the probe used another model beside it', async () => {
    const detected = await aClaude({ helper: 'claude-haiku-4-5-20251001' }).detector.detect({ version: '2.1.293', previous: undefined, now: NOW });

    expect(detected?.options.model).toEqual(modelOption(ALL_IDS));
  });

  it('leaves out an alias the CLI refuses as unrecognized', async () => {
    const detected = await aClaude({ refused: ['fable'] }).detector.detect({ version: '2.1.293', previous: undefined, now: NOW });

    expect(detected?.options.model).toEqual(modelOption(['claude-opus-5-5', 'claude-sonnet-5-5']));
  });

  it('keeps the id an alias resolved to before at the same version when its probe now neither confirms nor refuses it', async () => {
    const previous: DetectedHarness = { version: '2.1.293', detectedAt: BEFORE, confirmedAt: BEFORE, options: { model: modelOption(['claude-opus-5-5', 'claude-fable-5-1']) } };

    const detected = await aClaude({ resolves: {}, refused: ['fable'] }).detector.detect({ version: '2.1.293', previous, now: NOW });

    expect(detected?.options.model).toEqual(modelOption(['claude-opus-5-5']));
    expect(detected?.confirmedAt).toEqual(BEFORE);
  });

  it('keeps no id resolved at another version, and declares no model when none resolves', async () => {
    const previous: DetectedHarness = { version: '2.1.200', detectedAt: BEFORE, confirmedAt: BEFORE, options: { model: modelOption(['claude-opus-5-5']) } };

    const detected = await aClaude({ resolves: {} }).detector.detect({ version: '2.1.293', previous, now: NOW });

    expect(detected).toEqual({ version: '2.1.293', detectedAt: NOW, confirmedAt: null, options: { effort: EFFORT } });
  });

  it('declares no model when --help names no alias, and says why', async () => {
    const detected = await aClaude({ help: '  --effort <level>  Effort level (low, high)' }).detector.detect({ version: '2.1.293', previous: undefined, now: NOW });

    expect(detected).toEqual({
      version: '2.1.293',
      detectedAt: NOW,
      confirmedAt: null,
      options: { effort: { values: { low: ['--effort', 'low'], high: ['--effort', 'high'] } } },
      problem: "Claude Code 2.1.293's --help names no model alias, so this machine declares no Claude Code model: add the ones you want to its configuration",
    });
  });

  it('declares no effort when --help names no levels', async () => {
    const detected = await aClaude({ help: "  --model <model>  Model (e.g. 'opus')" }).detector.detect({ version: '2.1.293', previous: undefined, now: NOW });

    expect(detected?.options.effort).toBeUndefined();
  });
});
