import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { NO_TERMINAL_QUESTIONS } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonState } from '../adapters/json-state.js';
import { writeCrewFile } from '../adapters/files.js';
import { trierarchPaths } from '../adapters/paths.js';
import { runningVersion } from '../adapters/version.js';
import { aTrierarch, CONFIGURATION } from '../../test/support/in-memory.js';
import { main, USAGE } from './main.js';

/** The configuration as an operator writes it now (#382): no model, which comes from detection only, and an effort with its default. */
const CONFIGURED = {
  ...CONFIGURATION,
  harnesses: { 'claude-code': { flags: ['--verbose'], options: { effort: { values: { high: ['--effort', 'high'], low: ['--effort', 'low'] }, default: 'high' } } } },
};

let home: string;

/** The machine a test runs main on: its environment, and a managed settings folder of the test's own, so no test reads the machine's (#516). */
/** The machine main runs on: Linux unless a test names another platform, and its managed settings in the test's own folder. */
const machine = (env: Readonly<Record<string, string | undefined>>, platform = 'linux') => ({ env, managedSettings: join(home, 'managed'), platform });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-main-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    expect(output).toContain('claude-code: --verbose --effort high');
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

  it('config check prints the command each harness launches, on a first start and a restart, with each flag marked as configured or added by the adapter: Claude Code headless, its prompt its first line (headless H11), Codex with its prompt and the line no human reads the terminal (#588)', async () => {
    const config = join(home, 'both.json');
    writeFileSync(config, JSON.stringify({ ...CONFIGURED, harnesses: { ...CONFIGURED.harnesses, codex: { flags: ['--dangerously-bypass-approvals-and-sandbox'], options: {} } } }));

    const { output } = await main(['config', 'check', '--config', config], machine({ HOME: home }));

    expect(output).toContain(
      [
        `  first start: claude -p --input-format stream-json --output-format stream-json --verbose (adapter) --verbose --effort high (configuration) --permission-mode default (adapter, when the Claude Code settings for the folder make plan the default mode) --disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode (adapter)`,
        `  restart: claude -p --input-format stream-json --output-format stream-json --verbose (adapter) --verbose --effort high (configuration) --permission-mode default (adapter, when the Claude Code settings for the folder make plan the default mode) --disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode (adapter) --continue (adapter)`,
      ].join('\n'),
    );
    expect(output).toContain(
      [
        `  first start: codex exec --dangerously-bypass-approvals-and-sandbox (configuration) --json (adapter) --config=tools.experimental_request_user_input.enabled=false (adapter) -- "<first prompt>\\n\\n${NO_TERMINAL_QUESTIONS}"`,
        `  restart: codex exec resume --last --dangerously-bypass-approvals-and-sandbox (configuration) --json (adapter) --config=tools.experimental_request_user_input.enabled=false (adapter) -- "$aeolus-fleet-wake ${NO_TERMINAL_QUESTIONS}"`,
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

    expect(output).toContain('  first start: claude -p --input-format stream-json --output-format stream-json --verbose (adapter) --permission-mode default (adapter) --disallowedTools');
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

    expect(output).toContain('  first start: claude -p --input-format stream-json --output-format stream-json --verbose (adapter) --permission-mode manual (adapter) --disallowedTools');
  });

  it('config check shows no --permission-mode default when the flags name a permission mode of their own (#507)', async () => {
    const config = join(home, 'mode.json');
    writeFileSync(config, JSON.stringify({ ...CONFIGURATION, harnesses: { 'claude-code': { flags: ['--permission-mode', 'acceptEdits'], options: {} } } }));

    const { output } = await main(['config', 'check', '--config', config], machine({ HOME: home }));

    expect(output).toContain('  first start: claude -p --input-format stream-json --output-format stream-json --verbose (adapter) --permission-mode acceptEdits (configuration) --disallowedTools');
  });

  it('config check gives the flags each adapter adds, beside the configured ones, as JSON with --json', async () => {
    const config = join(home, 'elsewhere.json');
    writeFileSync(config, JSON.stringify(CONFIGURED));

    const { output } = await main(['config', 'check', '--json', '--config', config], machine({ HOME: home }));

    expect(JSON.parse(output)).toMatchObject({
      harnesses: {
        'claude-code': {
          flags: ['--verbose', '--effort', 'high'],
          adapterFlags: [
            { flag: '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', when: 'always' },
            { flag: '--continue', when: 'restart' },
          ],
          restart: [
            { words: ['claude'] },
            { words: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], source: 'adapter' },
            { words: ['--verbose', '--effort', 'high'], source: 'configuration' },
            { words: ['--permission-mode', 'default'], source: 'adapter', when: 'the Claude Code settings for the folder make plan the default mode' },
            { words: ['--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode'], source: 'adapter' },
            { words: ['--continue'], source: 'adapter' },
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

  it("login gives each harness's login and key state, keeping keys in the trierarch's keys folder, and names its forms in its usage (api keys K11)", async () => {
    mkdirSync(join(home, '.aeolus', 'trierarch', 'keys'), { recursive: true });
    writeFileSync(join(home, '.aeolus', 'trierarch', 'keys', 'codex'), 'test-key-not-real', { mode: 0o600 });

    const { output, code } = await main(['login', '--json'], machine({ HOME: home }));

    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ harnesses: [{ harness: 'claude-code', key: 'none' }, { harness: 'codex', key: 'ready' }] });
    expect(output).not.toContain('test-key-not-real');
    expect(USAGE).toContain('  login <harness> --api-key');
    expect(USAGE).toContain('  login <harness> --remove-key');
  });

  it("login takes a harness's default and a ship's exception, and names both forms in its usage (api keys K11)", async () => {
    const config = join(home, 'env.json');
    writeFileSync(config, JSON.stringify(CONFIGURATION));

    await expect(main(['login', 'codex', '--default', 'api-key'], machine({ HOME: home, AEOLUS_TRIERARCH_CONFIG: config }))).resolves.toMatchObject({ code: 0 });
    await expect(main(['login', '--ship', 'build-docs', 'subscription'], machine({ HOME: home, AEOLUS_TRIERARCH_CONFIG: config }))).resolves.toMatchObject({ code: 0 });

    expect(JSON.parse(readFileSync(config, 'utf8'))).toMatchObject({ logins: { default: { codex: 'apiKey' }, ships: { 'build-docs': 'subscription' } } });
    expect(USAGE).toContain('  login <harness> --default api-key|subscription');
    expect(USAGE).toContain('  login --ship <name> api-key|subscription|default');
    expect(USAGE).toContain('  login <harness> --check');
  });

  it('login refuses a login it does not know', async () => {
    const { output, code } = await main(['login', 'codex', '--default', 'key'], machine({ HOME: home }));

    expect(code).toBe(1);
    expect(output).toBe('A login is api-key or subscription: aeolus-trierarch login codex --default api-key');
  });

  it.each([['--api-key'], ['--remove-key'], ['--check'], ['--default', 'api-key']])("login refuses Copilot with %s, naming that it signs in with the computer's own login (CC6)", async (...words) => {
    const { output, code } = await main(['login', 'copilot', ...words], machine({ HOME: home }));

    expect(code).toBe(1);
    expect(output).toBe("Copilot signs in with this computer's own login (copilot login), never an API key: the trierarch keeps no Copilot key and runs every Copilot session on that login");
  });

  it('login refuses a harness it does not know, naming the ones it does', async () => {
    const { output, code } = await main(['login', 'gemini', '--remove-key'], machine({ HOME: home }));

    expect(code).toBe(1);
    expect(output).toBe('login takes claude-code or codex: aeolus-trierarch login claude-code --api-key');
  });

  it('says to run init, exiting 1, when there is no configuration yet', async () => {
    const { output, code } = await main(['config', 'check'], machine({ HOME: home }));

    expect(code).toBe(1);
    expect(output).toBe(`No configuration at ${join(home, '.aeolus', 'trierarch', 'config.json')}: run aeolus-trierarch init first`);
  });

  it('names every command in its usage', () => {
    for (const command of ['init', 'status', 'list', 'logs', 'start', 'stop', 'restart', 'upgrade', 'install', 'uninstall', 'config check', 'detect', 'login', 'run']) {
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
      harnesses: { 'claude-code': { flags: ['--verbose', '--effort', 'high'], options: { effort: { high: ['--effort', 'high'], low: ['--effort', 'low'] } } } },
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

// Init runs real processes and writes configuration files. Use the shell-script
// suite's budget while a full test run shares the machine.
const INIT_TIMEOUT_MS = 30_000;

/** `codex debug models` cut to what detection reads: two models it shows, both confirmed by a probe. */
const CODEX_CATALOG = JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }, { slug: 'gpt-6-luna', visibility: 'list' }] });

/**
 * The programs main runs, as stand-ins first on PATH, so no test runs the
 * machine's own: a Claude Code that is not installed, a Codex that lists and
 * confirms its models but whose app server ends on its first request, and a systemctl that does
 * nothing. `sh` is the system's, for `command -v`.
 */
function standInPrograms(): void {
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const program = (name: string, script: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  };
  // Reuse system executables: first executions of fresh shell scripts are slow on macOS.
  symlinkSync('/bin/sh', join(bin, 'sh'));
  symlinkSync('/usr/bin/false', join(bin, 'claude'));
  program('codex', `case "$1" in\n  --version) echo "codex-cli 0.160.1" ;;\n  debug) echo '${CODEX_CATALOG}' ;;\n  exec) echo OK ;;\n  app-server) read -r line; exit 1 ;;\n  *) exit 1 ;;\nesac`);
  symlinkSync('/usr/bin/true', join(bin, 'systemctl'));
  vi.stubEnv('PATH', bin);
}

describe('aeolus-trierarch with CLAUDE_CONFIG_DIR and CODEX_HOME set (#521)', () => {
  const both = () => ({ HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude-config'), CODEX_HOME: join(home, 'codex-home') });
  const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

  /** A machine set up already, offering both harnesses with Claude Code skipping permissions, its service installed or not. */
  async function aSetUpMachine(at: { isServiceInstalled: boolean }): Promise<void> {
    const paths = trierarchPaths({ homeDirectory: home });
    await writeCrewFile(paths.crewToken, { fleetUrl: 'https://fleet.example', shipId: 'shp_01m487vd5pdz6zh6s0jdnkg9p6', crewToken: 'crew-token' });
    writeFileSync(
      paths.config,
      JSON.stringify({ ...CONFIGURATION, repositories: {}, folders: {}, harnesses: { 'claude-code': { flags: ['--dangerously-skip-permissions'], options: {} }, codex: { flags: [], options: {} } } }),
    );
    if (at.isServiceInstalled) {
      mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
      writeFileSync(join(home, '.config', 'systemd', 'user', 'aeolus-trierarch.service'), '');
    }
    mkdirSync(join(home, 'codex-home'));
    writeFileSync(join(home, 'codex-home', 'config.toml'), 'model = "gpt-6-luna"\n');
    standInPrograms();
  }

  it("init answers Claude Code's questions in CLAUDE_CONFIG_DIR and its summary names the files it wrote there", async () => {
    await aSetUpMachine({ isServiceInstalled: true });
    const claudeJson = join(home, 'claude-config', '.claude.json');
    const settings = join(home, 'claude-config', 'settings.json');

    const { output, code } = await main(['init', '--yes'], machine(both()));

    expect(code, output).toBe(0);
    expect(json(claudeJson)).toMatchObject({ hasCompletedOnboarding: true });
    expect(json(settings)).toMatchObject({ skipDangerousModePermissionPrompt: true });
    expect(existsSync(join(home, '.claude.json')) || existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
    expect(output).toContain(`(hasCompletedOnboarding in ${claudeJson})`);
    expect(output).toContain(`(skipDangerousModePermissionPrompt in ${settings})`);
    expect(output).not.toContain('~/.claude');
  }, INIT_TIMEOUT_MS);

  it('init detects the default Codex model from config.toml in CODEX_HOME', async () => {
    await aSetUpMachine({ isServiceInstalled: true });

    const { output } = await main(['init', '--yes'], machine(both()));

    expect(output).toContain('codex 0.160.1: model gpt-6.1-sol, gpt-6-luna (default);');
  }, INIT_TIMEOUT_MS);

  it('install --no-load, as the installed version runs it in an upgrade, rewrites config.schema.json for its version', async () => {
    await aSetUpMachine({ isServiceInstalled: true });
    const { configSchema } = trierarchPaths({ homeDirectory: home });
    writeFileSync(configSchema, '{"stale":true}\n');

    const { output, code } = await main(['install', '--no-load'], machine(both()));

    expect(code, output).toBe(0);
    expect(json(configSchema)).toMatchObject({ type: 'object', properties: { $schema: expect.anything() } });
    expect(json(configSchema)).not.toHaveProperty('stale');
  }, INIT_TIMEOUT_MS);

  it('add trusts a place in .claude.json under CLAUDE_CONFIG_DIR, leaving ~/.claude.json alone', async () => {
    await aSetUpMachine({ isServiceInstalled: false });
    const drafts = join(home, 'drafts');
    mkdirSync(drafts);

    const { output, code } = await main(['add', 'folder', 'drafts', drafts], machine(both()));

    expect(code, output).toBe(0);
    expect(json(join(home, 'claude-config', '.claude.json'))).toMatchObject({ projects: { [drafts]: { hasTrustDialogAccepted: true } } });
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
  });

});

describe('aeolus-trierarch upgrade', () => {
  it('upgrade updates the aeolus-fleet plugin and exits 1, saying why, when it could not be updated (#581)', async () => {
    // Stand-ins on PATH: npm says the trierarch is on its latest version already, Codex's plugin upgrade fails.
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const program = (name: string, script: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
      chmodSync(join(bin, name), 0o700);
    };
    program('npm', `echo ${runningVersion()}`);
    program('codex', 'if [ "$4" = ThomasHendrickx/aeolus-fleet-trierarch ]; then echo "Error: could not reach github.com" >&2; exit 1; fi');
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const paths = trierarchPaths({ homeDirectory: home });
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ ...CONFIGURATION, harnesses: { codex: { flags: [], options: {} } } }));

    const { output, code } = await main(['upgrade'], machine({ HOME: home }));

    expect(code).toBe(1);
    expect(output).toContain('The aeolus-fleet plugin for Codex was not updated: codex plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch failed: Error: could not reach github.com.');
  });
});
