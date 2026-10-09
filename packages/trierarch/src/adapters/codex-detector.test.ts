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

/**
 * `codex debug models` as codex-cli 0.160.1 prints it on the mac mini, cut to
 * what detection reads: the catalog it runs with now. It hides gpt-5.5,
 * which a ChatGPT login may use, and shows gpt-6.1-sol, which it refuses (#392).
 */
const LIVE_CATALOG = JSON.stringify({
  models: [
    { slug: 'gpt-6.1-sol', visibility: 'list' },
    { slug: 'gpt-6-luna', visibility: 'list' },
    { slug: 'gpt-5.5', visibility: 'hide' },
  ],
});

/** How a probe of a model ends: confirmed, refused for this login as codex-cli 0.160.1 says it, or neither (offline, timed out). */
type ProbeEnd = 'confirmed' | 'refused' | 'unknown';

const PROBE_ANSWERS: Readonly<Record<ProbeEnd, (slug: string) => CommandResult>> = {
  confirmed: () => ({ status: 0, stdout: 'OK\n', stderr: '' }),
  refused: (slug) => ({
    status: 1,
    stdout: '',
    stderr: `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '${slug}' model is not supported when using Codex with a ChatGPT account."}}\n`,
  }),
  unknown: () => ({ status: 1, stdout: '', stderr: 'ERROR: stream disconnected before completion: error sending request\n' }),
};

const NEUTRAL_FOLDER = '/tmp/aeolus-trierarch-probe-x1';

/**
 * Codex 0.160.1: `catalog` answers `debug models --bundled`, and `live`, when
 * given, answers `debug models`; without it, that fails as on a Codex before
 * it. Each model's probe ends as `probes` says, confirmed when it says
 * nothing; the probes run are kept, in order.
 */
function aCodex(at: { catalog?: CommandResult; config?: string; live?: CommandResult; probes?: Readonly<Record<string, ProbeEnd>> } = {}) {
  const probed: { args: readonly string[]; cwd: string | undefined }[] = [];
  const run = (command: string, options: { args: readonly string[]; cwd?: string }): Promise<CommandResult> => {
    expect(command).toBe('codex');
    if (options.args[0] === '--version') {
      return Promise.resolve({ status: 0, stdout: 'codex-cli 0.160.1\n', stderr: '' });
    }
    if (options.args[0] === 'exec') {
      probed.push({ args: options.args, cwd: options.cwd });
      const slug = options.args[options.args.indexOf('-m') + 1] ?? '';
      return Promise.resolve(PROBE_ANSWERS[at.probes?.[slug] ?? 'confirmed'](slug));
    }
    if (options.args.join(' ') === 'debug models') {
      return Promise.resolve(at.live ?? { status: 1, stdout: '', stderr: 'unknown command' });
    }
    expect(options.args).toEqual(['debug', 'models', '--bundled']);
    return Promise.resolve(at.catalog ?? { status: 0, stdout: CATALOG, stderr: '' });
  };
  return Object.assign(createCodexDetector({ run, readConfig: () => Promise.resolve(at.config), neutralFolder: () => Promise.resolve(NEUTRAL_FOLDER) }), { probed });
}

const MODEL_VALUES = { 'gpt-6.1-sol': ['-m', 'gpt-6.1-sol'], 'gpt-6-luna': ['-m', 'gpt-6-luna'], 'gpt-reserve': ['-m', 'gpt-reserve'] };

describe('detecting Codex (#365)', () => {
  it('probes each model of the catalog it runs with, hidden ones included, once, non-interactively from a neutral folder, and declares only those this login may use (#392)', async () => {
    const codex = aCodex({ live: { status: 0, stdout: LIVE_CATALOG, stderr: '' }, probes: { 'gpt-6.1-sol': 'refused' } });

    const detected = await codex.detect({ version: '0.160.1', previous: undefined, now: NOW });

    expect(codex.probed).toEqual(
      ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.5'].map((slug) => ({ args: ['exec', '--skip-git-repo-check', '-m', slug, 'Reply OK'], cwd: NEUTRAL_FOLDER })),
    );
    expect(detected?.options.model?.values).toEqual({ 'gpt-6-luna': ['-m', 'gpt-6-luna'], 'gpt-5.5': ['-m', 'gpt-5.5'] });
  });

  it('reads its version from --version', async () => {
    await expect(aCodex().version()).resolves.toBe('0.160.1');
  });

  it("declares the confirmed models with -m, the user's configured model as the default, and no effort", async () => {
    const detected = await aCodex({ config: 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n' }).detect({ version: '0.160.1', previous: undefined, now: NOW });

    expect(detected).toEqual({ version: '0.160.1', detectedAt: NOW, confirmedAt: NOW, options: { model: { values: MODEL_VALUES, default: 'gpt-6-luna' } } });
  });

  it('declares a default only when it is confirmed: the configured model, else the first confirmed model the catalog shows (#392)', async () => {
    const refusedConfigured = await aCodex({ config: 'model = "gpt-6.1-sol"\n', probes: { 'gpt-6.1-sol': 'refused' } }).detect({ version: '0.160.1', previous: undefined, now: NOW });
    const onlyHiddenConfirmed = await aCodex({ probes: { 'gpt-6.1-sol': 'refused', 'gpt-6-luna': 'refused' } }).detect({ version: '0.160.1', previous: undefined, now: NOW });

    expect(refusedConfigured?.options.model?.default).toBe('gpt-6-luna');
    expect(onlyHiddenConfirmed?.options.model).toEqual({ values: { 'gpt-reserve': ['-m', 'gpt-reserve'] } });
  });

  it("takes a configured model the catalog hides as the default once confirmed, and the catalog's first shown one when none is configured (#392)", async () => {
    const hidden = await aCodex({ config: 'model = "gpt-reserve"\n' }).detect({ version: '0.160.1', previous: undefined, now: NOW });
    const none = await aCodex().detect({ version: '0.160.1', previous: undefined, now: NOW });

    expect(hidden?.options.model?.default).toBe('gpt-reserve');
    expect(none?.options.model?.default).toBe('gpt-6.1-sol');
  });

  it('reads the model of the top level only, not of a profile', async () => {
    const detected = await aCodex({ config: '[profiles.fast]\nmodel = "gpt-6-luna"\n' }).detect({ version: '0.160.1', previous: undefined, now: NOW });

    expect(detected?.options.model?.default).toBe('gpt-6.1-sol');
  });

  it('keeps a model confirmed before at the same version when its probe neither confirms nor refuses it, and drops one refused now (#392)', async () => {
    const previous = { version: '0.160.1', detectedAt: NOW, confirmedAt: NOW, options: { model: { values: MODEL_VALUES, default: 'gpt-6.1-sol' } } };
    const later = new Date('2026-10-09T09:00:00.000Z');

    const detected = await aCodex({ probes: { 'gpt-6.1-sol': 'unknown', 'gpt-6-luna': 'refused', 'gpt-reserve': 'unknown' } }).detect({ version: '0.160.1', previous, now: later });

    expect(detected).toEqual({ version: '0.160.1', detectedAt: later, confirmedAt: NOW, options: { model: { values: { 'gpt-6.1-sol': ['-m', 'gpt-6.1-sol'], 'gpt-reserve': ['-m', 'gpt-reserve'] }, default: 'gpt-6.1-sol' } } });
  });

  it('declares no model, and says why, when no probe confirms one (#392)', async () => {
    const detected = await aCodex({ probes: { 'gpt-6.1-sol': 'refused', 'gpt-6-luna': 'unknown', 'gpt-reserve': 'unknown' } }).detect({ version: '0.160.1', previous: undefined, now: NOW });

    expect(detected).toEqual({
      version: '0.160.1',
      detectedAt: NOW,
      confirmedAt: null,
      options: {},
      problem: "Codex 0.160.1 confirmed none of its catalog's models for this login, so this machine declares no Codex model",
    });
  });

  it('gives nothing to detect when the catalog does not come, or lists no model', async () => {
    await expect(aCodex({ catalog: { status: 1, stdout: '', stderr: 'unknown command' } }).detect({ version: '0.160.1', previous: undefined, now: NOW })).resolves.toBeUndefined();
    await expect(aCodex({ catalog: { status: 0, stdout: JSON.stringify({ models: [] }), stderr: '' } }).detect({ version: '0.160.1', previous: undefined, now: NOW })).resolves.toBeUndefined();
  });
});
