import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aeolusPluginVersion, findAeolusPlugin } from './plugin.js';

let home: string;

/** Where a found plugin is, with its root as it resolves now. */
async function found(at: Parameters<typeof findAeolusPlugin>[0]) {
  const plugin = await findAeolusPlugin(at);
  return { root: await plugin.root(), data: plugin.data, crews: plugin.crews };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-home-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('finding the aeolus-fleet plugin', () => {
  it("takes the newest version in Claude Code's plugin cache, the plugin's data folder, and ~/.aeolus/crews/claude-code for the identities (#658)", async () => {
    for (const version of ['0.9.0', '0.16.0', '0.10.2']) {
      mkdirSync(join(home, '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet', version), { recursive: true });
    }

    await expect(found({ homeDirectory: home, env: {} })).resolves.toEqual({
      root: join(home, '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet', '0.16.0'),
      data: join(home, '.claude', 'plugins', 'data', 'aeolus-fleet-aeolus-fleet'),
      crews: join(home, '.aeolus', 'crews', 'claude-code'),
    });
  });

  it('takes AEOLUS_PLUGIN_ROOT and AEOLUS_PLUGIN_DATA when set', async () => {
    await expect(found({ homeDirectory: home, env: { AEOLUS_PLUGIN_ROOT: '/plugin', AEOLUS_PLUGIN_DATA: '/data' } })).resolves.toEqual({ root: '/plugin', data: '/data', crews: join(home, '.aeolus', 'crews', 'claude-code') });
  });

  it('says the plugin is not installed when the cache has none', async () => {
    await expect(findAeolusPlugin({ homeDirectory: home, env: {} })).rejects.toThrow('The aeolus-fleet plugin is not installed');
  });

  it('says it found the renamed aeolus plugin when aeolus-fleet is not installed (#1312)', async () => {
    mkdirSync(join(home, '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus', '0.31.1'), { recursive: true });

    await expect(findAeolusPlugin({ homeDirectory: home, env: {} })).rejects.toThrow('The aeolus-fleet plugin is not installed for Claude Code (found aeolus in');
  });
});

describe('finding the aeolus-fleet plugin for Codex', () => {
  it("takes the newest version in Codex's plugin cache, the plugin's data folder, and ~/.aeolus/crews/codex for the identities (#658)", async () => {
    for (const version of ['0.17.2', '0.9.0']) {
      mkdirSync(join(home, '.codex', 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet', version), { recursive: true });
    }

    await expect(found({ homeDirectory: home, env: {}, harness: 'codex' })).resolves.toEqual({
      root: join(home, '.codex', 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet', '0.17.2'),
      data: join(home, '.codex', 'plugins', 'data', 'aeolus-fleet-aeolus-fleet'),
      crews: join(home, '.aeolus', 'crews', 'codex'),
    });
  });

  it('looks in CODEX_HOME when it is set, as Codex does', async () => {
    const codexHome = join(home, 'elsewhere');
    mkdirSync(join(codexHome, 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet', '0.17.2'), { recursive: true });

    await expect(found({ homeDirectory: home, env: { CODEX_HOME: codexHome }, harness: 'codex' })).resolves.toEqual({
      root: join(codexHome, 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet', '0.17.2'),
      data: join(codexHome, 'plugins', 'data', 'aeolus-fleet-aeolus-fleet'),
      crews: join(home, '.aeolus', 'crews', 'codex'),
    });
  });

  it('takes AEOLUS_CODEX_PLUGIN_ROOT and AEOLUS_CODEX_PLUGIN_DATA when set, never the variables for Claude Code', async () => {
    const env = { AEOLUS_PLUGIN_ROOT: '/claude-plugin', AEOLUS_CODEX_PLUGIN_ROOT: '/plugin', AEOLUS_CODEX_PLUGIN_DATA: '/data' };

    await expect(found({ homeDirectory: home, env, harness: 'codex' })).resolves.toEqual({ root: '/plugin', data: '/data', crews: join(home, '.aeolus', 'crews', 'codex') });
  });

  it('says the plugin is not installed for Codex when its cache has none', async () => {
    await expect(findAeolusPlugin({ homeDirectory: home, env: {}, harness: 'codex' })).rejects.toThrow('The aeolus-fleet plugin is not installed for Codex');
  });
});

describe('finding the aeolus-fleet plugin for Copilot', () => {
  it("takes the plugin Copilot installed in its installed-plugins folder, its plugin data folder, and ~/.aeolus/crews/copilot for the identities", async () => {
    mkdirSync(join(home, '.copilot', 'installed-plugins', 'aeolus-fleet', 'aeolus-fleet', 'scripts'), { recursive: true });

    await expect(found({ homeDirectory: home, env: {}, harness: 'copilot' })).resolves.toEqual({
      root: join(home, '.copilot', 'installed-plugins', 'aeolus-fleet', 'aeolus-fleet'),
      data: join(home, '.copilot', 'plugin-data', 'aeolus-fleet', 'aeolus-fleet'),
      crews: join(home, '.aeolus', 'crews', 'copilot'),
    });
  });

  it('looks in COPILOT_HOME when it is set, as Copilot does', async () => {
    const copilotHome = join(home, 'copilot-home');
    mkdirSync(join(copilotHome, 'installed-plugins', 'aeolus-fleet', 'aeolus-fleet'), { recursive: true });

    await expect(found({ homeDirectory: home, env: { COPILOT_HOME: copilotHome }, harness: 'copilot' })).resolves.toEqual({
      root: join(copilotHome, 'installed-plugins', 'aeolus-fleet', 'aeolus-fleet'),
      data: join(copilotHome, 'plugin-data', 'aeolus-fleet', 'aeolus-fleet'),
      crews: join(home, '.aeolus', 'crews', 'copilot'),
    });
  });

  it('takes AEOLUS_COPILOT_PLUGIN_ROOT and AEOLUS_COPILOT_PLUGIN_DATA when set, as for a plugin Copilot loads live from a local marketplace', async () => {
    await expect(found({ homeDirectory: home, env: { AEOLUS_COPILOT_PLUGIN_ROOT: '/plugin', AEOLUS_COPILOT_PLUGIN_DATA: '/data', AEOLUS_PLUGIN_ROOT: '/claude' }, harness: 'copilot' })).resolves.toEqual({ root: '/plugin', data: '/data', crews: join(home, '.aeolus', 'crews', 'copilot') });
  });

  it('says the plugin is not installed for Copilot at each use while Copilot installed none, so the trierarch starts and names Copilot as not offered', async () => {
    const plugin = await findAeolusPlugin({ homeDirectory: home, env: {}, harness: 'copilot' });

    await expect(plugin.root()).rejects.toThrow('The aeolus-fleet plugin is not installed for Copilot');
  });

  it('finds the plugin Copilot installed after the trierarch started', async () => {
    const plugin = await findAeolusPlugin({ homeDirectory: home, env: {}, harness: 'copilot' });
    mkdirSync(join(home, '.copilot', 'installed-plugins', 'aeolus-fleet', 'aeolus-fleet'), { recursive: true });

    await expect(plugin.root()).resolves.toBe(join(home, '.copilot', 'installed-plugins', 'aeolus-fleet', 'aeolus-fleet'));
  });
});

/** A plugin folder with the manifest the harness reads, saying the version. */
function aPlugin({ root, manifest, version }: { root: string; manifest: '.claude-plugin' | '.codex-plugin' | '.github/plugin'; version: string }): void {
  mkdirSync(join(root, manifest), { recursive: true });
  writeFileSync(join(root, manifest, 'plugin.json'), JSON.stringify({ name: 'aeolus-fleet', version }));
}

describe('the version of the aeolus-fleet plugin a harness installed (#480)', () => {
  it("is what Claude Code's manifest of the plugin it uses says", async () => {
    const cache = join(home, '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet');
    aPlugin({ root: join(cache, '0.20.3'), manifest: '.claude-plugin', version: '0.20.3' });
    aPlugin({ root: join(cache, '0.20.4'), manifest: '.claude-plugin', version: '0.20.4' });

    await expect(aeolusPluginVersion({ homeDirectory: home, env: {}, harness: 'claude-code' })).resolves.toBe('0.20.4');
  });

  it("is what Codex's manifest of the plugin it uses says", async () => {
    aPlugin({ root: join(home, '.codex', 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet', '0.20.4'), manifest: '.codex-plugin', version: '0.20.4' });

    await expect(aeolusPluginVersion({ homeDirectory: home, env: {}, harness: 'codex' })).resolves.toBe('0.20.4');
  });

  it("is what Copilot's manifest of the plugin it uses says", async () => {
    aPlugin({ root: join(home, '.copilot', 'installed-plugins', 'aeolus-fleet', 'aeolus-fleet'), manifest: '.github/plugin', version: '0.34.0' });

    await expect(aeolusPluginVersion({ homeDirectory: home, env: {}, harness: 'copilot' })).resolves.toBe('0.34.0');
  });

  it("is what Claude Code's manifest says of the plugin in its cache under CLAUDE_CONFIG_DIR when it is set (#474)", async () => {
    const configDir = join(home, 'claude-config');
    aPlugin({ root: join(configDir, 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet', '0.20.5'), manifest: '.claude-plugin', version: '0.20.5' });
    aPlugin({ root: join(home, '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet', '0.20.4'), manifest: '.claude-plugin', version: '0.20.4' });

    await expect(aeolusPluginVersion({ homeDirectory: home, env: { CLAUDE_CONFIG_DIR: configDir }, harness: 'claude-code' })).resolves.toBe('0.20.5');
  });

  it('is read from the plugin AEOLUS_PLUGIN_ROOT names when set', async () => {
    const root = join(home, 'checkout');
    aPlugin({ root, manifest: '.claude-plugin', version: '0.21.0' });

    await expect(aeolusPluginVersion({ homeDirectory: home, env: { AEOLUS_PLUGIN_ROOT: root }, harness: 'claude-code' })).resolves.toBe('0.21.0');
  });

  it('is none when the harness has no aeolus-fleet plugin', async () => {
    await expect(aeolusPluginVersion({ homeDirectory: home, env: {}, harness: 'codex' })).resolves.toBeUndefined();
  });

  it('is none when the plugin has no manifest saying it', async () => {
    mkdirSync(join(home, '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet', '0.20.4'), { recursive: true });

    await expect(aeolusPluginVersion({ homeDirectory: home, env: {}, harness: 'claude-code' })).resolves.toBeUndefined();
  });

  it('is none for a harness that installs no aeolus-fleet plugin', async () => {
    await expect(aeolusPluginVersion({ homeDirectory: home, env: {}, harness: 'pi' })).resolves.toBeUndefined();
  });
});
