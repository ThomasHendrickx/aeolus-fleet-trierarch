import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { AeolusPlugin } from './plugin-identity.js';

/** The harnesses that install the aeolus plugin, each in its own plugin folders. */
export type PluginHarness = 'claude-code' | 'codex';

/** Where each harness keeps its plugins, and the variables that point elsewhere. */
function placesOf(at: { homeDirectory: string; env: Readonly<Record<string, string | undefined>>; harness: PluginHarness }) {
  const { homeDirectory, env } = at;
  if (at.harness === 'codex') {
    return { name: 'Codex', plugins: join(env.CODEX_HOME ?? join(homeDirectory, '.codex'), 'plugins'), root: env.AEOLUS_CODEX_PLUGIN_ROOT, data: env.AEOLUS_CODEX_PLUGIN_DATA, rootVariable: 'AEOLUS_CODEX_PLUGIN_ROOT' };
  }
  return { name: 'Claude Code', plugins: join(homeDirectory, '.claude', 'plugins'), root: env.AEOLUS_PLUGIN_ROOT, data: env.AEOLUS_PLUGIN_DATA, rootVariable: 'AEOLUS_PLUGIN_ROOT' };
}

/**
 * Where a harness installed the aeolus plugin: the newest version in its
 * plugin cache and the plugin's data folder, unless variables name others
 * (AEOLUS_PLUGIN_ROOT and AEOLUS_PLUGIN_DATA for Claude Code,
 * AEOLUS_CODEX_PLUGIN_ROOT and AEOLUS_CODEX_PLUGIN_DATA for Codex, whose
 * folders follow CODEX_HOME as Codex does).
 */
export async function findAeolusPlugin(at: { homeDirectory: string; env: Readonly<Record<string, string | undefined>>; harness?: PluginHarness }): Promise<AeolusPlugin> {
  const places = placesOf({ ...at, harness: at.harness ?? 'claude-code' });
  const data = places.data ?? join(places.plugins, 'data', 'aeolus-aeolus-fleet');
  if (places.root !== undefined) {
    return { root: places.root, data };
  }
  const cache = join(places.plugins, 'cache', 'aeolus-fleet', 'aeolus');
  const versions = (await readdir(cache).catch(() => [])).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort(byVersion);
  const newest = versions.at(-1);
  if (newest === undefined) {
    throw new Error(`The aeolus plugin is not installed for ${places.name} (nothing in ${cache}): install it, or set ${places.rootVariable}`);
  }
  return { root: join(cache, newest), data };
}

/** The part of a plugin's manifest the version is read from. */
const manifestSchema = z.object({ version: z.string() });

/**
 * The version of the aeolus plugin a harness uses, as the manifest that
 * harness reads says it (#480); none when the harness has no aeolus plugin or
 * its manifest says no version.
 */
export async function aeolusPluginVersion(at: { homeDirectory: string; env: Readonly<Record<string, string | undefined>>; harness: string }): Promise<string | undefined> {
  if (at.harness !== 'claude-code' && at.harness !== 'codex') {
    return undefined;
  }
  const plugin = await findAeolusPlugin({ ...at, harness: at.harness }).catch(() => undefined);
  if (plugin === undefined) {
    return undefined;
  }
  const manifest = join(plugin.root, at.harness === 'codex' ? '.codex-plugin' : '.claude-plugin', 'plugin.json');
  const text = await readFile(manifest, 'utf8').catch(() => undefined);
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.version : undefined;
  } catch {
    // A manifest that is no JSON says no version.
    return undefined;
  }
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
