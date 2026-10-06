import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findAeolusPlugin } from './plugin.js';

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
