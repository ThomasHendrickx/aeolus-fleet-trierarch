import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPluginUpdate } from './plugin-update.js';
import type { RunningProcess } from './running-processes.js';

// Against stand-ins for `codex` and `claude`: each logs the words it runs with.
// The Codex one does what Codex's own plugin upgrade does (#581): it installs
// the new version and deletes every other version folder. What it runs in
// another CODEX_HOME than the test's, the proof that Codex keeps the plugin's
// data (#660), it logs as `probe:`.

let home: string;
let log: string;
let codex: string;
let claude: string;
let processes: RunningProcess[];
let trierarchPid: number | undefined;

/** When the upgrade runs: the clock the update reads. */
const NOW = new Date('2026-10-11T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * HOUR);
}

function codexCache(codexHome = join(home, '.codex')): string {
  return join(codexHome, 'plugins', 'cache', 'aeolus-fleet', 'aeolus');
}

/** A version of the aeolus plugin for Codex, as Codex installs it, with a script a running session uses. */
function aCodexVersion(version: string, at: { cache?: string; installedAt?: Date } = {}): void {
  const { cache = codexCache(), installedAt = hoursAgo(24) } = at;
  mkdirSync(join(cache, version, 'scripts'), { recursive: true });
  writeFileSync(join(cache, version, 'scripts', 'aeolus-fleet.sh'), `# ${version}\n`);
  utimesSync(join(cache, version), installedAt, installedAt);
}

/** A process running on this machine since `startedAt`. */
function aProcess(at: { pid?: number; program?: string; startedAt: Date }): RunningProcess {
  return { pid: at.pid ?? 4242, program: at.program ?? 'codex', startedAt: at.startedAt };
}

/** A stand-in program: logs its words, then runs `then` (JavaScript) and exits with `status`, printing `stderr`. */
function aProgram(path: string, at: { then?: string; status?: number; stderr?: string } = {}): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const probe = process.env.CODEX_HOME !== ${JSON.stringify(process.env.CODEX_HOME)} ? 'probe: ' : '';
appendFileSync(${JSON.stringify(log)}, probe + require('node:path').basename(process.argv[1]) + ' ' + process.argv.slice(2).join(' ') + '\\n');
${at.then ?? ''}
process.stderr.write(${JSON.stringify(at.stderr ?? '')});
process.exit(${String(at.status ?? 0)});
`,
  );
  chmodSync(path, 0o700);
}

/** `code` run only when the stand-in runs as `codex plugin marketplace upgrade`. */
function onUpgrade(code: string): string {
  return `if (process.argv[4] === 'upgrade') {\n${code}\n}`;
}

/** Codex's own plugin upgrade: the new version in, every other version folder deleted. */
function codexUpgrading(to: string, cache = codexCache()): string {
  return onUpgrade(`const cache = ${JSON.stringify(cache)};
mkdirSync(cache, { recursive: true });
for (const name of readdirSync(cache)) rmSync(join(cache, name), { recursive: true });
mkdirSync(join(cache, ${JSON.stringify(to)}, 'scripts'), { recursive: true });
writeFileSync(join(cache, ${JSON.stringify(to)}, 'scripts', 'aeolus-fleet.sh'), '# ${to}\\n');`);
}

/** Claude Code's user settings in `configDirectory`. */
function aSettingsFile(configDirectory: string, settings: Record<string, unknown>): void {
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

function settingsIn(configDirectory: string): unknown {
  return JSON.parse(readFileSync(join(configDirectory, 'settings.json'), 'utf8'));
}

/** Each run of a stand-in, the proof's too. */
function runs(): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : [];
}

/** What the stand-ins ran where the update runs them, the proof's runs left out. */
function ran(): string[] {
  return runs().filter((line) => !line.startsWith('probe: '));
}

/** The words of a Codex that deletes its plugins' data when a marketplace is removed. */
const DELETES_DATA_ON_REMOVE = "if (process.argv[4] === 'remove' && process.env.CODEX_HOME !== undefined) rmSync(join(process.env.CODEX_HOME, 'plugins', 'data'), { recursive: true, force: true });";

function update(env: Record<string, string> = {}) {
  return createPluginUpdate({
    homeDirectory: home,
    env,
    commands: { codex, 'claude-code': claude },
    now: () => NOW,
    processes: () => Promise.resolve(processes),
    trierarchPid: () => Promise.resolve(trierarchPid),
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aeolus-plugin-update-'));
  log = join(home, 'ran.log');
  codex = join(home, 'codex');
  claude = join(home, 'claude');
  aProgram(claude);
  processes = [];
  trierarchPid = undefined;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the aeolus plugin update for Codex', () => {
  it("runs Codex's own plugin upgrade for the aeolus-fleet marketplace", async () => {
    aCodexVersion('0.21.0');
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(ran().at(-1)).toBe('codex plugin marketplace upgrade aeolus-fleet');
  });

  it("points Codex's aeolus-fleet marketplace at the release tag it is given before the upgrade, adding it again since Codex adds no second source (#652)", async () => {
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(ran()).toEqual(['codex plugin marketplace remove aeolus-fleet', 'codex plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch --ref v0.23.0', 'codex plugin marketplace upgrade aeolus-fleet']);
  });

  it('installs the plugin when the upgrade left Codex with none, as when its cache folder was emptied (#1212)', async () => {
    aProgram(codex);

    await update().update('codex', 'v0.23.0');

    expect(ran().slice(-2)).toEqual(['codex plugin marketplace upgrade aeolus-fleet', 'codex plugin add aeolus@aeolus-fleet']);
  });

  it('installs nothing beyond the upgrade when Codex has the plugin after it (#1212)', async () => {
    aCodexVersion('0.21.0');
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(ran()).not.toContain('codex plugin add aeolus@aeolus-fleet');
  });

  it('says what Codex said when it cannot install the plugin (#1212)', async () => {
    aProgram(codex, { then: "if (probe === '' && process.argv[3] === 'add' && process.argv[2] === 'plugin') { process.stderr.write('Error: plugin not found in aeolus-fleet'); process.exit(1); }" });

    await expect(update().update('codex', 'v0.23.0')).rejects.toThrow('codex plugin add aeolus@aeolus-fleet failed: Error: plugin not found in aeolus-fleet');
  });

  it("points Codex's aeolus-fleet marketplace at main when it is given no tag (#652)", async () => {
    aProgram(codex);

    await update().update('codex', undefined);

    expect(ran()).toContain('codex plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch');
  });

  it('adds the marketplace also when Codex had none to remove (#652)', async () => {
    aProgram(codex, { then: `${codexUpgrading('0.22.0')}\nif (probe === '' && process.argv[4] === 'remove') { process.stderr.write('Error: marketplace \`aeolus-fleet\` is not configured or installed'); process.exit(1); }` });

    await update().update('codex', 'v0.23.0');

    expect(ran().at(-1)).toBe('codex plugin marketplace upgrade aeolus-fleet');
  });

  it("says what Codex said when it cannot add the marketplace, and upgrades nothing (#652)", async () => {
    aProgram(codex, { then: "if (probe === '' && process.argv[4] === 'add') { process.stderr.write('Error: could not reach github.com'); process.exit(1); }" });

    await expect(update().update('codex', 'v0.23.0')).rejects.toThrow('codex plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch --ref v0.23.0 failed: Error: could not reach github.com');
    expect(ran()).not.toContain('codex plugin marketplace upgrade aeolus-fleet');
  });

  it('keeps the version folders running Codex sessions use beside the new one, as they were (#581)', async () => {
    aCodexVersion('0.21.0');
    processes = [aProcess({ startedAt: hoursAgo(1) })];
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(readdirSync(codexCache()).sort()).toEqual(['0.21.0', '0.22.0']);
    expect(readFileSync(join(codexCache(), '0.21.0', 'scripts', 'aeolus-fleet.sh'), 'utf8')).toBe('# 0.21.0\n');
  });

  it("puts the version folders running sessions use back when Codex's upgrade fails, saying what Codex said (#581)", async () => {
    aCodexVersion('0.21.0');
    aProgram(codex, { then: onUpgrade(`rmSync(join(${JSON.stringify(codexCache())}, '0.21.0'), { recursive: true }); process.stderr.write('Error: could not reach github.com\\n'); process.exit(1);`) });

    await expect(update().update('codex', 'v0.23.0')).rejects.toThrow('codex plugin marketplace upgrade aeolus-fleet failed: Error: could not reach github.com');
    expect(readFileSync(join(codexCache(), '0.21.0', 'scripts', 'aeolus-fleet.sh'), 'utf8')).toBe('# 0.21.0\n');
  });

  it('keeps the versions in the plugin folders of CODEX_HOME when it is set', async () => {
    const codexHome = join(home, 'elsewhere');
    aCodexVersion('0.21.0', { cache: codexCache(codexHome) });
    processes = [aProcess({ startedAt: hoursAgo(1) })];
    aProgram(codex, { then: codexUpgrading('0.22.0', codexCache(codexHome)) });

    await update({ CODEX_HOME: codexHome }).update('codex', 'v0.23.0');

    expect(readdirSync(codexCache(codexHome)).sort()).toEqual(['0.21.0', '0.22.0']);
  });

  it('removes the version folders no running Codex session uses: each one whose next version came before every session started (#653)', async () => {
    aCodexVersion('0.20.5', { installedAt: hoursAgo(48) });
    aCodexVersion('0.21.0', { installedAt: hoursAgo(24) });
    processes = [aProcess({ startedAt: hoursAgo(2) })];
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(readdirSync(codexCache()).sort()).toEqual(['0.21.0', '0.22.0']);
  });

  it('keeps every version folder a Codex session that started before its next version may use (#653)', async () => {
    aCodexVersion('0.20.5', { installedAt: hoursAgo(48) });
    aCodexVersion('0.21.0', { installedAt: hoursAgo(24) });
    processes = [aProcess({ startedAt: hoursAgo(30) })];
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(readdirSync(codexCache()).sort()).toEqual(['0.20.5', '0.21.0', '0.22.0']);
  });

  it('keeps only the new version when no Codex session runs (#653)', async () => {
    aCodexVersion('0.20.5', { installedAt: hoursAgo(48) });
    aCodexVersion('0.21.0', { installedAt: hoursAgo(24) });
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(readdirSync(codexCache())).toEqual(['0.22.0']);
  });

  it('counts a process only when its program is codex (#653)', async () => {
    aCodexVersion('0.21.0');
    processes = [aProcess({ program: 'node', startedAt: hoursAgo(30) }), aProcess({ program: '/opt/codex-tools/codexer', startedAt: hoursAgo(30) })];
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(readdirSync(codexCache())).toEqual(['0.22.0']);
  });

  it('counts a codex program by any path (#653)', async () => {
    aCodexVersion('0.21.0');
    processes = [aProcess({ program: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', startedAt: hoursAgo(30) })];
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(readdirSync(codexCache()).sort()).toEqual(['0.21.0', '0.22.0']);
  });

  it('keeps the version folder the running trierarch took its plugin scripts from (#653)', async () => {
    aCodexVersion('0.21.0');
    trierarchPid = 777;
    processes = [aProcess({ pid: 777, program: 'node', startedAt: hoursAgo(30) })];
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(readdirSync(codexCache()).sort()).toEqual(['0.21.0', '0.22.0']);
  });

  it('keeps a version folder for a session that started within a minute after its next version came, as ps counts whole seconds (#653)', async () => {
    aCodexVersion('0.20.5', { installedAt: hoursAgo(48) });
    aCodexVersion('0.21.0', { installedAt: hoursAgo(24) });
    processes = [aProcess({ startedAt: new Date(hoursAgo(24).getTime() + 59_000) })];
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(readdirSync(codexCache()).sort()).toEqual(['0.20.5', '0.21.0', '0.22.0']);
  });

  it('removes a version folder for a session that started a minute after its next version came (#653)', async () => {
    aCodexVersion('0.20.5', { installedAt: hoursAgo(48) });
    aCodexVersion('0.21.0', { installedAt: hoursAgo(24) });
    processes = [aProcess({ startedAt: new Date(hoursAgo(24).getTime() + 60_000) })];
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(readdirSync(codexCache()).sort()).toEqual(['0.21.0', '0.22.0']);
  });

  it('counts the new version from when the upgrade installed it, not from the times Codex gave its files (#653)', async () => {
    aCodexVersion('0.21.0');
    processes = [aProcess({ startedAt: hoursAgo(1) })];
    const installed = join(codexCache(), '0.22.0');
    aProgram(codex, { then: `${codexUpgrading('0.22.0')}\n${onUpgrade(`require('node:fs').utimesSync(${JSON.stringify(installed)}, new Date(${String(hoursAgo(48).getTime())}), new Date(${String(hoursAgo(48).getTime())}));`)}` });

    await update().update('codex', 'v0.23.0');

    expect(readdirSync(codexCache()).sort()).toEqual(['0.21.0', '0.22.0']);
  });

  it('leaves folders that name no version alone (#653)', async () => {
    aCodexVersion('0.21.0');
    mkdirSync(join(codexCache(), 'local'));
    aProgram(codex, { then: onUpgrade(`rmSync(join(${JSON.stringify(codexCache())}, '0.21.0'), { recursive: true }); mkdirSync(join(${JSON.stringify(codexCache())}, '0.22.0'));`) });

    await update().update('codex', 'v0.23.0');

    expect(readdirSync(codexCache()).sort()).toEqual(['0.22.0', 'local']);
  });

  it("removes nothing when Codex's upgrade fails (#653)", async () => {
    aCodexVersion('0.20.5', { installedAt: hoursAgo(48) });
    aCodexVersion('0.21.0', { installedAt: hoursAgo(24) });
    aProgram(codex, { then: onUpgrade("process.stderr.write('Error: could not reach github.com'); process.exit(1);") });

    await expect(update().update('codex', 'v0.23.0')).rejects.toThrow('codex plugin marketplace upgrade aeolus-fleet failed: Error: could not reach github.com');
    expect(readdirSync(codexCache()).sort()).toEqual(['0.20.5', '0.21.0']);
  });

  it("proves Codex keeps the aeolus plugin's data before it removes the aeolus-fleet marketplace (#660)", async () => {
    aProgram(codex);

    await update().update('codex', 'v0.23.0');

    const beforeRemove = runs().slice(0, runs().indexOf('codex plugin marketplace remove aeolus-fleet'));
    expect(beforeRemove).toContain('probe: codex plugin marketplace remove aeolus-fleet');
  });

  it("refuses to remove the aeolus-fleet marketplace when Codex would delete the aeolus plugin's data with it, its log and the crew identities not yet moved to ~/.aeolus/crews, and changes nothing (#660, #679)", async () => {
    aCodexVersion('0.21.0');
    aProgram(codex, { then: DELETES_DATA_ON_REMOVE });

    await expect(update().update('codex', 'v0.23.0')).rejects.toThrow("Codex would delete the aeolus plugin's data on this machine, its log and the crew identities not yet moved to ~/.aeolus/crews, when its aeolus-fleet marketplace is removed: the upgrade leaves the marketplace as it is");
    expect(ran()).toEqual([]);
    expect(readdirSync(codexCache())).toEqual(['0.21.0']);
  });

  it('changes nothing when Codex cannot run the proof, saying what Codex said (#660)', async () => {
    aProgram(codex, { then: "if (process.argv.slice(2).join(' ') === 'plugin add aeolus@aeolus-fleet') { process.stderr.write('Error: plugin aeolus not found'); process.exit(1); }" });

    await expect(update().update('codex', 'v0.23.0')).rejects.toThrow('codex plugin add aeolus@aeolus-fleet failed: Error: plugin aeolus not found');
    expect(ran()).toEqual([]);
  });

  it('runs the upgrade where Codex has no aeolus plugin version yet', async () => {
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex', 'v0.23.0');

    expect(ran().at(-1)).toBe('codex plugin marketplace upgrade aeolus-fleet');
  });
});

describe('the aeolus plugin update for Claude Code', () => {
  it("points Claude Code's aeolus-fleet marketplace at the release tag it is given, updates it, then the aeolus plugin from it (#652)", async () => {
    await update().update('claude-code', 'v0.23.0');

    expect(ran()).toEqual(['claude plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch#v0.23.0', 'claude plugin marketplace update aeolus-fleet', 'claude plugin update aeolus@aeolus-fleet']);
  });

  it("points Claude Code's aeolus-fleet marketplace at main when it is given no tag (#652)", async () => {
    await update().update('claude-code', undefined);

    expect(ran()[0]).toBe('claude plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch');
  });

  it("drops the aeolus-fleet marketplace Claude Code's settings declare before adding it again, since Claude Code adds no other source while they declare one, and keeps the rest (#652)", async () => {
    aSettingsFile(join(home, '.claude'), { theme: 'dark', extraKnownMarketplaces: { 'aeolus-fleet': { source: { source: 'github', repo: 'ThomasHendrickx/aeolus-fleet', ref: 'v0.22.0' } }, other: { source: { source: 'github', repo: 'someone/other' } } } });

    await update().update('claude-code', 'v0.23.0');

    expect(settingsIn(join(home, '.claude'))).toEqual({ theme: 'dark', extraKnownMarketplaces: { other: { source: { source: 'github', repo: 'someone/other' } } } });
  });

  it('drops it from the settings in CLAUDE_CONFIG_DIR when it is set (#652)', async () => {
    const configDirectory = join(home, 'claude-elsewhere');
    aSettingsFile(configDirectory, { extraKnownMarketplaces: { 'aeolus-fleet': { source: { source: 'github', repo: 'ThomasHendrickx/aeolus-fleet' } } } });

    await update({ CLAUDE_CONFIG_DIR: configDirectory }).update('claude-code', 'v0.23.0');

    expect(settingsIn(configDirectory)).toEqual({ extraKnownMarketplaces: {} });
  });

  it('leaves settings that declare no aeolus-fleet marketplace as they are, and writes none where there are none (#652)', async () => {
    aSettingsFile(join(home, '.claude'), { theme: 'dark' });
    const before = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');

    await update().update('claude-code', 'v0.23.0');
    await update({ CLAUDE_CONFIG_DIR: join(home, 'none') }).update('claude-code', 'v0.23.0');

    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(before);
    expect(existsSync(join(home, 'none', 'settings.json'))).toBe(false);
  });

  it('says what Claude Code said when its update fails', async () => {
    aProgram(claude, { status: 1, stderr: 'Plugin "aeolus@aeolus-fleet" is not installed\n' });

    await expect(update().update('claude-code', 'v0.23.0')).rejects.toThrow('claude plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch#v0.23.0 failed: Plugin "aeolus@aeolus-fleet" is not installed');
  });
});
