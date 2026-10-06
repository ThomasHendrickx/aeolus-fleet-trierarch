import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createJsonState } from '../adapters/json-state.js';
import { trierarchPaths } from '../adapters/paths.js';
import { runningVersion } from '../adapters/version.js';
import { aTrierarch, aWant, CONFIGURATION } from '../../test/support/in-memory.js';
import { main, USAGE } from './main.js';

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
    writeFileSync(config, JSON.stringify(CONFIGURATION));

    const { output, code } = await main(['config', 'check', '--config', config], { HOME: home });

    expect(code).toBe(0);
    expect(output).toContain(`The configuration at ${config} fits.`);
    expect(output).toContain('claude-code: --remote-control --model claude-opus-5-5');
  });

  it('config check prints the command each harness launches, on a first start and a restart, with each flag marked as configured or added by the adapter', async () => {
    const config = join(home, 'both.json');
    writeFileSync(config, JSON.stringify({ ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: ['--dangerously-bypass-approvals-and-sandbox'], options: {} } } }));

    const { output } = await main(['config', 'check', '--config', config], { HOME: home });

    expect(output).toContain(
      [
        '  first start: claude "<first prompt>" --remote-control (configuration) "[<repository or folder>] <ship>" (adapter) --model claude-opus-5-5 (configuration)',
        '  restart: claude /aeolus:wake --remote-control (configuration) "[<repository or folder>] <ship>" (adapter) --model claude-opus-5-5 (configuration) --continue (adapter)',
      ].join('\n'),
    );
    expect(output).toContain(
      [
        '  first start: codex "<first prompt>" --dangerously-bypass-approvals-and-sandbox (configuration) --no-daemon (adapter)',
        '  restart: codex resume --last $aeolus-wake --dangerously-bypass-approvals-and-sandbox (configuration) --no-daemon (adapter)',
      ].join('\n'),
    );
  });

  it('config check gives the flags each adapter adds, beside the configured ones, as JSON with --json', async () => {
    const config = join(home, 'elsewhere.json');
    writeFileSync(config, JSON.stringify(CONFIGURATION));

    const { output } = await main(['config', 'check', '--json', '--config', config], { HOME: home });

    expect(JSON.parse(output)).toMatchObject({
      harnesses: {
        'claude-code': {
          flags: ['--remote-control', '--model', 'claude-opus-5-5'],
          adapterFlags: [{ flag: '--continue', when: 'restart' }],
          restart: [
            { words: ['claude', '/aeolus:wake'] },
            { words: ['--remote-control'], source: 'configuration' },
            { words: ['[<repository or folder>] <ship>'], source: 'adapter' },
            { words: ['--model', 'claude-opus-5-5'], source: 'configuration' },
            { words: ['--continue'], source: 'adapter' },
          ],
        },
      },
    });
  });

  it('reads the configuration AEOLUS_TRIERARCH_CONFIG names', async () => {
    const config = join(home, 'env.json');
    writeFileSync(config, JSON.stringify(CONFIGURATION));

    await expect(main(['config', 'check'], { HOME: home, AEOLUS_TRIERARCH_CONFIG: config })).resolves.toMatchObject({ code: 0 });
  });

  it('says to run init, exiting 1, when there is no configuration yet', async () => {
    const { output, code } = await main(['config', 'check'], { HOME: home });

    expect(code).toBe(1);
    expect(output).toBe(`No configuration at ${join(home, '.aeolus', 'trierarch', 'config.json')}: run aeolus-trierarch init first`);
  });

  it('names every command in its usage', () => {
    for (const command of ['init', 'status', 'list', 'logs', 'start', 'stop', 'restart', 'upgrade', 'install', 'uninstall', 'config check', 'run']) {
      expect(USAGE).toContain(`  ${command}`);
    }
    expect(USAGE).toContain('--json');
  });

  it('prints its usage, exiting 2, for a flag it does not know', async () => {
    await expect(main(['list', '--colour'], { HOME: home })).resolves.toEqual({ output: USAGE, code: 2 });
  });

  it('lists the wanted entries as JSON with --json, reading the saved state', async () => {
    const trierarch = aTrierarch();
    const scout = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(scout));
    await createJsonState(trierarchPaths({ homeDirectory: home }).state).save(trierarch.state.current());

    const { output, code } = await main(['list', '--json'], { HOME: home });

    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual([expect.objectContaining({ shipId: scout, state: 'wanted', workspace: 'worktree aeolus-fleet' })]);
  });

  it('answers a failure as JSON with --json', async () => {
    const { output, code } = await main(['config', 'check', '--json'], { HOME: home });

    expect(code).toBe(1);
    expect(JSON.parse(output)).toEqual({ error: `No configuration at ${join(home, '.aeolus', 'trierarch', 'config.json')}: run aeolus-trierarch init first` });
  });

  it('config check gives the effective flags per harness as JSON with --json', async () => {
    const config = join(home, 'config.json');
    writeFileSync(config, JSON.stringify(CONFIGURATION));

    const { output } = await main(['config', 'check', '--config', config, '--json'], { HOME: home });

    expect(JSON.parse(output)).toMatchObject({
      path: config,
      harnesses: { 'claude-code': { flags: ['--remote-control', '--model', 'claude-opus-5-5'], options: { model: { opus: ['--model', 'claude-opus-5-5'], sonnet: ['--model', 'claude-sonnet-5-5'] } } } },
    });
  });

  it('takes a flag value written with an equals sign', async () => {
    const config = join(home, 'config.json');
    writeFileSync(config, JSON.stringify(CONFIGURATION));

    await expect(main(['config', 'check', `--config=${config}`], { HOME: home })).resolves.toMatchObject({ code: 0 });
  });
});
