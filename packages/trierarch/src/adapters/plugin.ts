import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AeolusPlugin } from './plugin-identity.js';

/**
 * Where Claude Code installed the aeolus plugin: AEOLUS_PLUGIN_ROOT and
 * AEOLUS_PLUGIN_DATA when set, else the newest version in Claude Code's
 * plugin cache and the plugin's data folder.
 */
export async function findAeolusPlugin(at: { homeDirectory: string; env: Readonly<Record<string, string | undefined>> }): Promise<AeolusPlugin> {
  const plugins = join(at.homeDirectory, '.claude', 'plugins');
  const data = at.env.AEOLUS_PLUGIN_DATA ?? join(plugins, 'data', 'aeolus-aeolus-fleet');
  if (at.env.AEOLUS_PLUGIN_ROOT !== undefined) {
    return { root: at.env.AEOLUS_PLUGIN_ROOT, data };
  }
  const cache = join(plugins, 'cache', 'aeolus-fleet', 'aeolus');
  const versions = (await readdir(cache).catch(() => [])).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort(byVersion);
  const newest = versions.at(-1);
  if (newest === undefined) {
    throw new Error(`The aeolus plugin is not installed for Claude Code (nothing in ${cache}): install it, or set AEOLUS_PLUGIN_ROOT`);
  }
  return { root: join(cache, newest), data };
}

function byVersion(left: string, right: string): number {
  const [a, b] = [left, right].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index += 1) {
    const difference = (a?.[index] ?? 0) - (b?.[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
