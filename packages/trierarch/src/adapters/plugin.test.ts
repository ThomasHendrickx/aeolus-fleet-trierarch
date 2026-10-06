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
