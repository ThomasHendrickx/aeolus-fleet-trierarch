import { loadConfiguration } from '../adapters/files.js';
import { describeFlags, effectiveFlags } from '../adapters/flags.js';
import type { TrierarchPaths } from '../adapters/paths.js';

/** `aeolus-trierarch config check`: checks the configuration and gives the effective flags per harness. */
export interface ConfigCheckReport {
  readonly path: string;
  /** Per harness, the flags a want with no options launches with, and each option value's flags. */
  readonly harnesses: Readonly<Record<string, { flags: readonly string[]; options: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> }>>;
  readonly text: string;
}

export async function configCheck(paths: TrierarchPaths): Promise<ConfigCheckReport> {
  const configuration = await loadConfiguration(paths.config);
  const harnesses = Object.fromEntries(
    Object.entries(configuration.harnesses).map(([name, harness]) => [
      name,
      { flags: effectiveFlags(harness, {}), options: Object.fromEntries(Object.entries(harness.options).map(([option, settings]) => [option, settings.values])) },
    ]),
  );
  return {
    path: paths.config,
    harnesses,
    text: [`The configuration at ${paths.config} fits.`, 'Flags per harness (a want picks option values by name):', describeFlags(configuration)].join('\n'),
  };
}
