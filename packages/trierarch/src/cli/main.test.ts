import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createJsonState } from '../adapters/json-state.js';
import { trierarchPaths } from '../adapters/paths.js';
import { runningVersion } from '../adapters/version.js';
import { aTrierarch, CONFIGURATION } from '../../test/support/in-memory.js';
import { main, USAGE } from './main.js';

/** The configuration as an operator writes it now (#382): no model, which comes from detection only, and an effort with its default. */
const CONFIGURED = {
  ...CONFIGURATION,
  harnesses: { 'claude-code': { flags: ['--remote-control'], options: { effort: { values: { high: ['--effort', 'high'], low: ['--effort', 'low'] }, default: 'high' } } } },
};

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-main-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('aeolus-trierarch', () => {
  it('prints its usage, exiting 2, for no command or an unknown one', async () => {
    await expect(main([], { HOME: home })).resolves.toEqual({ output: USAGE, code: 2 });
    await expect(main(['sail'], { HOME: home })).resolves.toEqual({ output: USAGE, code: 2 });
  });

  it('prints the installed version for --version and -v', async () => {
    await expect(main(['--version'], { HOME: home })).resolves.toEqual({ output: runningVersion(), code: 0 });
    await expect(main(['-v'], { HOME: home })).resolves.toEqual({ output: runningVersion(), code: 0 });
  });

  it('answers the installed version as JSON with --version --json', async () => {
    const { output, code } = await main(['--version', '--json'], { HOME: home });

    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({ version: runningVersion() });
  });

  it('config check prints the effective flags per harness, reading the configuration --config names', async () => {
    const config = join(home, 'elsewhere.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));

    const { output, code } = await main(['config', 'check', '--config', config], { HOME: home });

    expect(code).toBe(0);
    expect(output).toContain(`The configuration at ${config} fits.`);
    expect(output).toContain('claude-code: --remote-control --effort high');
  });

  it('config check gives the detected options too, an option the operator wrote winning by its name, and the detected model always (#365, #382)', async () => {
    const config = join(home, 'detected.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));
    mkdirSync(join(home, '.aeolus', 'trierarch'), { recursive: true });
    const detectedAt = '2026-10-08T15:00:00.000Z';
    writeFileSync(
      join(home, '.aeolus', 'trierarch', 'detected.json'),
      JSON.stringify({
        'claude-code': {
          version: '2.1.293',
          detectedAt,
          confirmedAt: detectedAt,
          options: { model: { values: { 'claude-haiku-4-5-20251001': ['--model', 'claude-haiku-4-5-20251001'] } }, effort: { values: { high: ['--effort', 'high'] } } },
        },
      }),
    );

    const { output } = await main(['config', 'check', '--config', config], { HOME: home });

    expect(output).toContain('  effort=low: --effort low');
    expect(output).toContain('claude-haiku-4-5-20251001');
  });

  it('config check prints the command each harness launches, on a first start and a restart, with each flag marked as configured or added by the adapter', async () => {
    const config = join(home, 'both.json');
    writeFileSync(config, JSON.stringify({ ...CONFIGURED, harnesses: { ...CONFIGURED.harnesses, codex: { flags: ['--dangerously-bypass-approvals-and-sandbox'], options: {} } } }));

    const { output } = await main(['config', 'check', '--config', config], { HOME: home });

    expect(output).toContain(
      [
        '  first start: claude --remote-control (configuration) "[<repository or folder>] <ship>" (adapter) --effort high (configuration) -- "<first prompt>"',
        '  restart: claude --remote-control (configuration) "[<repository or folder>] <ship>" (adapter) --effort high (configuration) --continue (adapter) -- /aeolus:wake',
      ].join('\n'),
    );
    expect(output).toContain(
      [
        '  first start: codex --dangerously-bypass-approvals-and-sandbox (configuration) --no-daemon (adapter) -- "<first prompt>"',
        '  restart: codex resume --last --dangerously-bypass-approvals-and-sandbox (configuration) --no-daemon (adapter) -- $aeolus-wake',
      ].join('\n'),
    );
  });

  it('config check gives the flags each adapter adds, beside the configured ones, as JSON with --json', async () => {
    const config = join(home, 'elsewhere.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));

    const { output } = await main(['config', 'check', '--json', '--config', config], { HOME: home });

    expect(JSON.parse(output)).toMatchObject({
      harnesses: {
        'claude-code': {
          flags: ['--remote-control', '--effort', 'high'],
          adapterFlags: [{ flag: '--continue', when: 'restart' }],
          restart: [
            { words: ['claude'] },
            { words: ['--remote-control'], source: 'configuration' },
            { words: ['[<repository or folder>] <ship>'], source: 'adapter' },
            { words: ['--effort', 'high'], source: 'configuration' },
            { words: ['--continue'], source: 'adapter' },
            { words: ['--', '/aeolus:wake'] },
          ],
        },
      },
    });
  });

  it('config check refuses a model option in the configuration: model ids come from detection only (#382)', async () => {
    const config = join(home, 'with-model.json');
    writeFileSync(config, JSON.stringify(CONFIGURATION));

    const { output, code } = await main(['config', 'check', '--config', config], { HOME: home });

    expect(code).toBe(1);
    expect(stripVTControlCharacters(output)).toBe(
      `The configuration at ${config} sets a model option for claude-code: model ids come from detection only (#382), so remove it; aeolus-trierarch detect lists them`,
    );
  });

  it('reads the configuration AEOLUS_TRIERARCH_CONFIG names', async () => {
    const config = join(home, 'env.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));

    await expect(main(['config', 'check'], { HOME: home, AEOLUS_TRIERARCH_CONFIG: config })).resolves.toMatchObject({ code: 0 });
  });

  it('says to run init, exiting 1, when there is no configuration yet', async () => {
    const { output, code } = await main(['config', 'check'], { HOME: home });

    expect(code).toBe(1);
    expect(output).toBe(`No configuration at ${join(home, '.aeolus', 'trierarch', 'config.json')}: run aeolus-trierarch init first`);
  });

  it('names every command in its usage', () => {
    for (const command of ['init', 'status', 'list', 'logs', 'start', 'stop', 'restart', 'upgrade', 'install', 'uninstall', 'config check', 'detect', 'run']) {
      expect(USAGE).toContain(`  ${command}`);
    }
    expect(USAGE).toContain('--json');
  });

  it('prints its usage, exiting 2, for a flag it does not know', async () => {
    await expect(main(['list', '--colour'], { HOME: home })).resolves.toEqual({ output: USAGE, code: 2 });
  });

  it('lists the entries as JSON with --json, reading the saved state', async () => {
    const trierarch = aTrierarch();
    const scout = trierarch.fleet.commission('scout');
    trierarch.fleet.request(scout);
    await trierarch.pass();
    await createJsonState(trierarchPaths({ homeDirectory: home }).state).save(trierarch.state.current());

    const { output, code } = await main(['list', '--json'], { HOME: home });

    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual([expect.objectContaining({ shipId: scout, state: 'running', workspace: 'worktree aeolus-fleet' })]);
  });

  it('colours a failure on a colour terminal, and answers plain JSON with --json all the same', async () => {
    const colour = { HOME: home, FORCE_COLOR: '1' };

    const text = await main(['config', 'check'], colour);
    const json = await main(['config', 'check', '--json'], colour);

    expect(text.output).not.toBe(stripVTControlCharacters(text.output));
    expect(stripVTControlCharacters(text.output)).toBe(`No configuration at ${join(home, '.aeolus', 'trierarch', 'config.json')}: run aeolus-trierarch init first`);
    expect(json.output).toBe(stripVTControlCharacters(json.output));
  });

  it('answers a failure as JSON with --json', async () => {
    const { output, code } = await main(['config', 'check', '--json'], { HOME: home });

    expect(code).toBe(1);
    expect(JSON.parse(output)).toEqual({ error: `No configuration at ${join(home, '.aeolus', 'trierarch', 'config.json')}: run aeolus-trierarch init first` });
  });

  it('config check gives the effective flags per harness as JSON with --json', async () => {
    const config = join(home, 'config.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));

    const { output } = await main(['config', 'check', '--config', config, '--json'], { HOME: home });

    expect(JSON.parse(output)).toMatchObject({
      path: config,
      harnesses: { 'claude-code': { flags: ['--remote-control', '--effort', 'high'], options: { effort: { high: ['--effort', 'high'], low: ['--effort', 'low'] } } } },
    });
  });

  it('logs renders the log for the operator, and gives its records with --json', async () => {
    const logs = join(home, '.aeolus', 'trierarch', 'logs');
    mkdirSync(logs, { recursive: true });
    const record = { time: '2026-10-06T15:00:00.000Z', shipId: 'shp_01m487vd5pdz6zh6s0jdnkg9p6', shipName: 'scout', action: 'wake', outcome: 'woken, deliveries wait' };
    writeFileSync(join(logs, 'trierarch.log'), `${JSON.stringify(record)}\nan older line\n`);

    const text = await main(['logs'], { HOME: home });
    const json = await main(['logs', '--json'], { HOME: home });

    expect(text.output).toBe('2026-10-06T15:00:00.000Z shp_01m487vd5pdz6zh6s0jdnkg9p6 (scout) wake: woken, deliveries wait\nan older line');
    expect(JSON.parse(json.output)).toEqual({ file: join(logs, 'trierarch.log'), lines: [record, { line: 'an older line' }] });
  });

  it('takes a flag value written with an equals sign', async () => {
    const config = join(home, 'config.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));

    await expect(main(['config', 'check', `--config=${config}`], { HOME: home })).resolves.toMatchObject({ code: 0 });
  });
});
