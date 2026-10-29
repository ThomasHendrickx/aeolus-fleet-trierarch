import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { AeolusPlugin } from './plugin-identity.js';

/** The harnesses that install the aeolus-fleet plugin, each in its own plugin folders. */
export type PluginHarness = 'claude-code' | 'codex';

export const PLUGIN_HARNESSES: readonly PluginHarness[] = ['claude-code', 'codex'];

/** Every harness the aeolus-fleet plugin crews a ship from: Claude Code and Codex, and Copilot, whose plugin the trierarch neither upgrades nor gives an API key. */
export type CrewHarness = PluginHarness | 'copilot';

/** The manifest each harness reads the plugin's version from. */
const MANIFESTS: Readonly<Record<CrewHarness, string>> = { 'claude-code': '.claude-plugin', codex: '.codex-plugin', copilot: join('.github', 'plugin') };

/** The aeolus-fleet plugin's data folder in a harness's plugin folders, as both harnesses name it. */
export const PLUGIN_DATA_FOLDER = 'aeolus-fleet-aeolus-fleet';

/** Where Claude Code and Codex keep their plugins, and the variables that point elsewhere. */
function placesOf(at: { homeDirectory: string; env: Readonly<Record<string, string | undefined>>; harness: PluginHarness }) {
  const { homeDirectory, env } = at;
  if (at.harness === 'codex') {
    return { name: 'Codex', plugins: join(env.CODEX_HOME ?? join(homeDirectory, '.codex'), 'plugins'), root: env.AEOLUS_CODEX_PLUGIN_ROOT, data: env.AEOLUS_CODEX_PLUGIN_DATA, rootVariable: 'AEOLUS_CODEX_PLUGIN_ROOT' };
  }
  return { name: 'Claude Code', plugins: join(env.CLAUDE_CONFIG_DIR ?? join(homeDirectory, '.claude'), 'plugins'), root: env.AEOLUS_PLUGIN_ROOT, data: env.AEOLUS_PLUGIN_DATA, rootVariable: 'AEOLUS_PLUGIN_ROOT' };
}

/**
 * Where Copilot installed the aeolus-fleet plugin: one folder per plugin in its
 * installed-plugins folder, with no version in the path, and the data folder
 * Copilot gives its hooks (`COPILOT_PLUGIN_DATA`, as Copilot CLI 1.0.105 sets
 * it), both in COPILOT_HOME when it is set, unless AEOLUS_COPILOT_PLUGIN_ROOT
 * and AEOLUS_COPILOT_PLUGIN_DATA name others, as for a plugin Copilot loads
 * live from a local marketplace. Unlike Claude Code's and Codex's, a missing
 * one does not stop the trierarch at start: the machine does not offer
 * Copilot until it is installed.
 */
function findCopilotPlugin(at: { homeDirectory: string; env: Readonly<Record<string, string | undefined>>; crews: string }): Promise<AeolusPlugin> {
  const { env } = at;
  const copilotHome = env.COPILOT_HOME ?? join(at.homeDirectory, '.copilot');
  const data = env.AEOLUS_COPILOT_PLUGIN_DATA ?? join(copilotHome, 'plugin-data', 'aeolus-fleet', 'aeolus-fleet');
  const root = env.AEOLUS_COPILOT_PLUGIN_ROOT ?? join(copilotHome, 'installed-plugins', 'aeolus-fleet', 'aeolus-fleet');
  if (env.AEOLUS_COPILOT_PLUGIN_ROOT !== undefined) {
    return Promise.resolve({ root: () => Promise.resolve(root), data, crews: at.crews });
  }
  // Looked for at each use, never at start: the trierarch starts without it, names Copilot as not offered, and finds it once installed (#1212).
  const installed = async (): Promise<string> => {
    if ((await stat(root).catch(() => undefined)) === undefined) {
      throw new Error(`The aeolus-fleet plugin is not installed for Copilot (nothing in ${root}): install it, or set AEOLUS_COPILOT_PLUGIN_ROOT`);
    }
    return root;
  };
  return Promise.resolve({ root: installed, data, crews: at.crews });
}

/**
 * Where a harness installed the aeolus-fleet plugin: for Claude Code and
 * Codex the newest version in its plugin cache, looked up again at each use
 * so a plugin upgrade without a service restart moves along (#828), and the
 * plugin's data folder, unless variables name others
 * (AEOLUS_PLUGIN_ROOT and AEOLUS_PLUGIN_DATA for Claude Code,
 * AEOLUS_CODEX_PLUGIN_ROOT and AEOLUS_CODEX_PLUGIN_DATA for Codex). The
 * folders follow CLAUDE_CONFIG_DIR and CODEX_HOME as the harnesses do. For
 * Copilot, as findCopilotPlugin says. The identities of the harness's
 * sessions live in ~/.aeolus/crews/<harness>, as the plugin keeps them
 * (decision 0015).
 */
export async function findAeolusPlugin(at: { homeDirectory: string; env: Readonly<Record<string, string | undefined>>; harness?: CrewHarness }): Promise<AeolusPlugin> {
  const harness = at.harness ?? 'claude-code';
  const crews = join(at.homeDirectory, '.aeolus', 'crews', harness);
  if (harness === 'copilot') {
    return findCopilotPlugin({ ...at, crews });
  }
  const places = placesOf({ ...at, harness });
  const data = places.data ?? join(places.plugins, 'data', PLUGIN_DATA_FOLDER);
  const { root } = places;
  if (root !== undefined) {
    return { root: () => Promise.resolve(root), data, crews };
  }
  const cache = join(places.plugins, 'cache', 'aeolus-fleet', 'aeolus-fleet');
  const renamedCache = join(places.plugins, 'cache', 'aeolus-fleet', 'aeolus');
  const newest = async (): Promise<string> => {
    const versions = (await readdir(cache).catch(() => [])).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort(byVersion);
    const version = versions.at(-1);
    if (version === undefined) {
      const renamedVersions = (await readdir(renamedCache).catch(() => [])).filter((name) => /^\d+\.\d+\.\d+$/.test(name));
      if (renamedVersions.length > 0) {
        throw new Error(`The aeolus-fleet plugin is not installed for ${places.name} (found aeolus in ${renamedCache}): install it, or set ${places.rootVariable}`);
      }
      throw new Error(`The aeolus-fleet plugin is not installed for ${places.name} (nothing in ${cache}): install it, or set ${places.rootVariable}`);
    }
    return join(cache, version);
  };
  // A trierarch without the plugin is refused at start, not at its first crew.
  await newest();
  return { root: newest, data, crews };
}

/** The part of a plugin's manifest the version is read from. */
const manifestSchema = z.object({ version: z.string() });

/**
 * The version of the aeolus-fleet plugin a harness uses, as the manifest that
 * harness reads says it (#480); none when the harness has no aeolus-fleet plugin or
 * its manifest says no version.
 */
export async function aeolusPluginVersion(at: { homeDirectory: string; env: Readonly<Record<string, string | undefined>>; harness: string }): Promise<string | undefined> {
  const harness = [...PLUGIN_HARNESSES, 'copilot' as const].find((name) => name === at.harness);
  if (harness === undefined) {
    return undefined;
  }
  const root = await findAeolusPlugin({ ...at, harness })
    .then((plugin) => plugin.root())
    .catch(() => undefined);
  if (root === undefined) {
    return undefined;
  }
  const manifest = join(root, MANIFESTS[harness], 'plugin.json');
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

/** Orders versions such as 0.9.0 and 0.10.0 by their numbers. */
export function byVersion(left: string, right: string): number {
  const [a, b] = [left, right].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index += 1) {
    const difference = (a?.[index] ?? 0) - (b?.[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
