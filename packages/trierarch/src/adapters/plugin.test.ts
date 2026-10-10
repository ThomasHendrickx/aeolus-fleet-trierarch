import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aeolusPluginVersion, findAeolusPlugin } from './plugin.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-home-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('finding the aeolus plugin', () => {
  it("takes the newest version in Claude Code's plugin cache, and the plugin's data folder", async () => {
    for (const version of ['0.9.0', '0.16.0', '0.10.2']) {
      mkdirSync(join(home, '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus', version), { recursive: true });
    }

    await expect(findAeolusPlugin({ homeDirectory: home, env: {} })).resolves.toEqual({
      root: join(home, '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus', '0.16.0'),
      data: join(home, '.claude', 'plugins', 'data', 'aeolus-aeolus-fleet'),
    });
  });

  it('takes AEOLUS_PLUGIN_ROOT and AEOLUS_PLUGIN_DATA when set', async () => {
    await expect(findAeolusPlugin({ homeDirectory: home, env: { AEOLUS_PLUGIN_ROOT: '/plugin', AEOLUS_PLUGIN_DATA: '/data' } })).resolves.toEqual({ root: '/plugin', data: '/data' });
  });

  it('says the plugin is not installed when the cache has none', async () => {
    await expect(findAeolusPlugin({ homeDirectory: home, env: {} })).rejects.toThrow('The aeolus plugin is not installed');
  });
});

describe('finding the aeolus plugin for Codex', () => {
  it("takes the newest version in Codex's plugin cache, and the plugin's data folder", async () => {
    for (const version of ['0.17.2', '0.9.0']) {
      mkdirSync(join(home, '.codex', 'plugins', 'cache', 'aeolus-fleet', 'aeolus', version), { recursive: true });
    }

    await expect(findAeolusPlugin({ homeDirectory: home, env: {}, harness: 'codex' })).resolves.toEqual({
      root: join(home, '.codex', 'plugins', 'cache', 'aeolus-fleet', 'aeolus', '0.17.2'),
      data: join(home, '.codex', 'plugins', 'data', 'aeolus-aeolus-fleet'),
    });
  });

  it('looks in CODEX_HOME when it is set, as Codex does', async () => {
    const codexHome = join(home, 'elsewhere');
    mkdirSync(join(codexHome, 'plugins', 'cache', 'aeolus-fleet', 'aeolus', '0.17.2'), { recursive: true });

    await expect(findAeolusPlugin({ homeDirectory: home, env: { CODEX_HOME: codexHome }, harness: 'codex' })).resolves.toEqual({
      root: join(codexHome, 'plugins', 'cache', 'aeolus-fleet', 'aeolus', '0.17.2'),
      data: join(codexHome, 'plugins', 'data', 'aeolus-aeolus-fleet'),
    });
  });

  it('takes AEOLUS_CODEX_PLUGIN_ROOT and AEOLUS_CODEX_PLUGIN_DATA when set, never the variables for Claude Code', async () => {
    const env = { AEOLUS_PLUGIN_ROOT: '/claude-plugin', AEOLUS_CODEX_PLUGIN_ROOT: '/plugin', AEOLUS_CODEX_PLUGIN_DATA: '/data' };

    await expect(findAeolusPlugin({ homeDirectory: home, env, harness: 'codex' })).resolves.toEqual({ root: '/plugin', data: '/data' });
  });

  it('says the plugin is not installed for Codex when its cache has none', async () => {
    await expect(findAeolusPlugin({ homeDirectory: home, env: {}, harness: 'codex' })).rejects.toThrow('The aeolus plugin is not installed for Codex');
  });
});

/** A plugin folder with the manifest the harness reads, saying the version. */
function aPlugin({ root, manifest, version }: { root: string; manifest: '.claude-plugin' | '.codex-plugin'; version: string }): void {
  mkdirSync(join(root, manifest), { recursive: true });
  writeFileSync(join(root, manifest, 'plugin.json'), JSON.stringify({ name: 'aeolus', version }));
}

describe('the version of the aeolus plugin a harness installed (#480)', () => {
  it("is what Claude Code's manifest of the plugin it uses says", async () => {
    const cache = join(home, '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus');
    aPlugin({ root: join(cache, '0.20.3'), manifest: '.claude-plugin', version: '0.20.3' });
    aPlugin({ root: join(cache, '0.20.4'), manifest: '.claude-plugin', version: '0.20.4' });

    await expect(aeolusPluginVersion({ homeDirectory: home, env: {}, harness: 'claude-code' })).resolves.toBe('0.20.4');
  });

  it("is what Codex's manifest of the plugin it uses says", async () => {
    aPlugin({ root: join(home, '.codex', 'plugins', 'cache', 'aeolus-fleet', 'aeolus', '0.20.4'), manifest: '.codex-plugin', version: '0.20.4' });

    await expect(aeolusPluginVersion({ homeDirectory: home, env: {}, harness: 'codex' })).resolves.toBe('0.20.4');
  });

  it('is read from the plugin AEOLUS_PLUGIN_ROOT names when set', async () => {
    const root = join(home, 'checkout');
    aPlugin({ root, manifest: '.claude-plugin', version: '0.21.0' });

    await expect(aeolusPluginVersion({ homeDirectory: home, env: { AEOLUS_PLUGIN_ROOT: root }, harness: 'claude-code' })).resolves.toBe('0.21.0');
  });

  it('is none when the harness has no aeolus plugin', async () => {
    await expect(aeolusPluginVersion({ homeDirectory: home, env: {}, harness: 'codex' })).resolves.toBeUndefined();
  });

  it('is none when the plugin has no manifest saying it', async () => {
    mkdirSync(join(home, '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus', '0.20.4'), { recursive: true });

    await expect(aeolusPluginVersion({ homeDirectory: home, env: {}, harness: 'claude-code' })).resolves.toBeUndefined();
  });

  it('is none for a harness that installs no aeolus plugin', async () => {
    await expect(aeolusPluginVersion({ homeDirectory: home, env: {}, harness: 'pi' })).resolves.toBeUndefined();
  });
});
