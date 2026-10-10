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

/** The machine a test runs main on: its environment, and a managed settings folder of the test's own, so no test reads the machine's (#516). */
/** The machine main runs on: Linux unless a test names another platform, and its managed settings in the test's own folder. */
const machine = (env: Readonly<Record<string, string | undefined>>, platform = 'linux') => ({ env, managedSettings: join(home, 'managed'), platform });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-main-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('aeolus-trierarch', () => {
  it('prints its usage, exiting 2, for no command or an unknown one', async () => {
    await expect(main([], machine({ HOME: home }))).resolves.toEqual({ output: USAGE, code: 2 });
    await expect(main(['sail'], machine({ HOME: home }))).resolves.toEqual({ output: USAGE, code: 2 });
  });

  it('prints the installed version for --version and -v', async () => {
    await expect(main(['--version'], machine({ HOME: home }))).resolves.toEqual({ output: runningVersion(), code: 0 });
    await expect(main(['-v'], machine({ HOME: home }))).resolves.toEqual({ output: runningVersion(), code: 0 });
  });

  it('answers the installed version as JSON with --version --json', async () => {
    const { output, code } = await main(['--version', '--json'], machine({ HOME: home }));

    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({ version: runningVersion() });
  });

  it('config check prints the effective flags per harness, reading the configuration --config names', async () => {
    const config = join(home, 'elsewhere.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));

    const { output, code } = await main(['config', 'check', '--config', config], machine({ HOME: home }));

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

    const { output } = await main(['config', 'check', '--config', config], machine({ HOME: home }));

    expect(output).toContain('  effort=low: --effort low');
    expect(output).toContain('claude-haiku-4-5-20251001');
  });

  it('config check prints the command each harness launches, on a first start and a restart, with each flag marked as configured or added by the adapter', async () => {
    const config = join(home, 'both.json');
    writeFileSync(config, JSON.stringify({ ...CONFIGURED, harnesses: { ...CONFIGURED.harnesses, codex: { flags: ['--dangerously-bypass-approvals-and-sandbox'], options: {} } } }));

    const { output } = await main(['config', 'check', '--config', config], machine({ HOME: home }));

    expect(output).toContain(
      [
        '  first start: claude --remote-control (configuration) "[<repository or folder>] <ship>" (adapter) --effort high (configuration) --permission-mode default (adapter, when the Claude Code settings for the folder make plan the default mode) --disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode (adapter) -- "<first prompt>"',
        '  restart: claude --remote-control (configuration) "[<repository or folder>] <ship>" (adapter) --effort high (configuration) --permission-mode default (adapter, when the Claude Code settings for the folder make plan the default mode) --disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode (adapter) --continue (adapter) -- /aeolus:wake',
      ].join('\n'),
    );
    expect(output).toContain(
      [
        '  first start: codex --dangerously-bypass-approvals-and-sandbox (configuration) --no-daemon (adapter) --config=tools.experimental_request_user_input.enabled=false (adapter) -- "<first prompt>"',
        '  restart: codex resume --last --dangerously-bypass-approvals-and-sandbox (configuration) --no-daemon (adapter) --config=tools.experimental_request_user_input.enabled=false (adapter) -- $aeolus-wake',
      ].join('\n'),
    );
  });

  it("config check shows the command a launch runs when --settings decides Claude Code's default mode, which the folder's settings cannot change: --permission-mode default for plan, nothing for another mode (#507)", async () => {
    const config = join(home, 'settings.json');
    const firstStartWith = async (settings: object) => {
      writeFileSync(config, JSON.stringify({ ...CONFIGURATION, harnesses: { 'claude-code': { flags: ['--settings', JSON.stringify(settings)], options: {} } } }));
      return (await main(['config', 'check', '--config', config], machine({ HOME: home }))).output.split('\n').find((line) => line.startsWith('  first start: claude'));
    };

    expect(await firstStartWith({ permissions: { defaultMode: 'plan' } })).toContain('(configuration) --permission-mode default (adapter) --disallowedTools');
    expect(await firstStartWith({ permissions: { defaultMode: 'acceptEdits' } })).not.toContain('--permission-mode');
  });

  it("config check reads Claude Code's managed settings in the folder the machine gives, never the system's own (#516)", async () => {
    const config = join(home, 'managed.json');
    writeFileSync(config, JSON.stringify({ ...CONFIGURATION, harnesses: { 'claude-code': { flags: [], options: {} } } }));
    const managedSettings = join(home, 'managed');
    mkdirSync(managedSettings);
    writeFileSync(join(managedSettings, 'managed-settings.json'), JSON.stringify({ permissions: { defaultMode: 'plan' } }));

    const { output } = await main(['config', 'check', '--config', config], { env: { HOME: home }, managedSettings, platform: 'linux' });

    expect(output).toContain('  first start: claude --permission-mode default (adapter) --disallowedTools');
  });

  it('config check shows the override with the mode the detected Claude Code lists: manual where it lists manual (#517)', async () => {
    const config = join(home, 'manual.json');
    writeFileSync(config, JSON.stringify({ ...CONFIGURATION, harnesses: { 'claude-code': { flags: [], options: {} } } }));
    mkdirSync(join(home, 'managed'));
    writeFileSync(join(home, 'managed', 'managed-settings.json'), JSON.stringify({ permissions: { defaultMode: 'plan' } }));
    mkdirSync(join(home, '.aeolus', 'trierarch'), { recursive: true });
    const detectedAt = '2026-10-10T15:00:00.000Z';
    writeFileSync(
      join(home, '.aeolus', 'trierarch', 'detected.json'),
      JSON.stringify({ 'claude-code': { version: '2.1.296', detectedAt, confirmedAt: detectedAt, options: {}, permissionModes: ['acceptEdits', 'manual', 'plan'] } }),
    );

    const { output } = await main(['config', 'check', '--config', config], machine({ HOME: home }));

    expect(output).toContain('  first start: claude --permission-mode manual (adapter) --disallowedTools');
  });

  it('config check shows no --permission-mode default when the flags name a permission mode of their own (#507)', async () => {
    const config = join(home, 'mode.json');
    writeFileSync(config, JSON.stringify({ ...CONFIGURATION, harnesses: { 'claude-code': { flags: ['--permission-mode', 'acceptEdits'], options: {} } } }));

    const { output } = await main(['config', 'check', '--config', config], machine({ HOME: home }));

    expect(output).toContain('  first start: claude --permission-mode acceptEdits (configuration) --disallowedTools');
  });

  it('config check gives the flags each adapter adds, beside the configured ones, as JSON with --json', async () => {
    const config = join(home, 'elsewhere.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));

    const { output } = await main(['config', 'check', '--json', '--config', config], machine({ HOME: home }));

    expect(JSON.parse(output)).toMatchObject({
      harnesses: {
        'claude-code': {
          flags: ['--remote-control', '--effort', 'high'],
          adapterFlags: [
            { flag: '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', when: 'always' },
            { flag: '--continue', when: 'restart' },
          ],
          restart: [
            { words: ['claude'] },
            { words: ['--remote-control'], source: 'configuration' },
            { words: ['[<repository or folder>] <ship>'], source: 'adapter' },
            { words: ['--effort', 'high'], source: 'configuration' },
            { words: ['--permission-mode', 'default'], source: 'adapter', when: 'the Claude Code settings for the folder make plan the default mode' },
            { words: ['--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode'], source: 'adapter' },
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

    const { output, code } = await main(['config', 'check', '--config', config], machine({ HOME: home }));

    expect(code).toBe(1);
    expect(stripVTControlCharacters(output)).toBe(
      `The configuration at ${config} sets a model option for claude-code: model ids come from detection only (#382), so remove it; aeolus-trierarch detect lists them`,
    );
  });

  it('reads the configuration AEOLUS_TRIERARCH_CONFIG names', async () => {
    const config = join(home, 'env.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));

    await expect(main(['config', 'check'], machine({ HOME: home, AEOLUS_TRIERARCH_CONFIG: config }))).resolves.toMatchObject({ code: 0 });
  });

  it('add takes the kind, the name and the path of a place, and names both kinds in its usage (#381)', async () => {
    const config = join(home, 'env.json');
    writeFileSync(config, JSON.stringify(CONFIGURATION));

    const { output, code } = await main(['add', 'folder', 'drafts', join(home, 'drafts')], machine({ HOME: home, AEOLUS_TRIERARCH_CONFIG: config }));

    expect(code).toBe(1);
    expect(output).toBe(`${join(home, 'drafts')} is no folder.`);
    expect(USAGE).toContain('  add repository <name> <path>');
    expect(USAGE).toContain('  add folder <name> <path>');
  });

  it('says to run init, exiting 1, when there is no configuration yet', async () => {
    const { output, code } = await main(['config', 'check'], machine({ HOME: home }));

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
    await expect(main(['list', '--colour'], machine({ HOME: home }))).resolves.toEqual({ output: USAGE, code: 2 });
  });

  it('lists the entries as JSON with --json, reading the saved state', async () => {
    const trierarch = aTrierarch();
    const scout = trierarch.fleet.commission('scout');
    trierarch.fleet.request(scout);
    await trierarch.pass();
    await trierarch.pass();
    await createJsonState(trierarchPaths({ homeDirectory: home }).state).save(trierarch.state.current());

    const { output, code } = await main(['list', '--json'], machine({ HOME: home }));

    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual([expect.objectContaining({ shipId: scout, state: 'running', workspace: 'worktree aeolus-fleet' })]);
  });

  it('colours a failure on a colour terminal, and answers plain JSON with --json all the same', async () => {
    const colour = { HOME: home, FORCE_COLOR: '1' };

    const text = await main(['config', 'check'], machine(colour));
    const json = await main(['config', 'check', '--json'], machine(colour));

    expect(text.output).not.toBe(stripVTControlCharacters(text.output));
    expect(stripVTControlCharacters(text.output)).toBe(`No configuration at ${join(home, '.aeolus', 'trierarch', 'config.json')}: run aeolus-trierarch init first`);
    expect(json.output).toBe(stripVTControlCharacters(json.output));
  });

  it('answers a failure as JSON with --json', async () => {
    const { output, code } = await main(['config', 'check', '--json'], machine({ HOME: home }));

    expect(code).toBe(1);
    expect(JSON.parse(output)).toEqual({ error: `No configuration at ${join(home, '.aeolus', 'trierarch', 'config.json')}: run aeolus-trierarch init first` });
  });

  it('config check gives the effective flags per harness as JSON with --json', async () => {
    const config = join(home, 'config.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));

    const { output } = await main(['config', 'check', '--config', config, '--json'], machine({ HOME: home }));

    expect(JSON.parse(output)).toMatchObject({
      path: config,
      harnesses: { 'claude-code': { flags: ['--remote-control', '--effort', 'high'], options: { effort: { high: ['--effort', 'high'], low: ['--effort', 'low'] } } } },
    });
  });

  it('logs renders the log the launchd agent writes for the operator, and gives its records with --json', async () => {
    const logs = join(home, '.aeolus', 'trierarch', 'logs');
    mkdirSync(logs, { recursive: true });
    const record = { time: '2026-10-06T15:00:00.000Z', shipId: 'shp_01m487vd5pdz6zh6s0jdnkg9p6', shipName: 'scout', action: 'wake', outcome: 'woken, deliveries wait' };
    writeFileSync(join(logs, 'trierarch.log'), `${JSON.stringify(record)}\nan older line\n`);

    const text = await main(['logs'], machine({ HOME: home }, 'darwin'));
    const json = await main(['logs', '--json'], machine({ HOME: home }, 'darwin'));

    expect(text.output).toBe('2026-10-06T15:00:00.000Z shp_01m487vd5pdz6zh6s0jdnkg9p6 (scout) wake: woken, deliveries wait\nan older line');
    expect(JSON.parse(json.output)).toEqual({ file: join(logs, 'trierarch.log'), lines: [record, { line: 'an older line' }] });
  });

  it('takes a flag value written with an equals sign', async () => {
    const config = join(home, 'config.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));

    await expect(main(['config', 'check', `--config=${config}`], machine({ HOME: home }))).resolves.toMatchObject({ code: 0 });
  });
});
