import { loadConfiguration } from '../adapters/files.js';
import { describeFlags } from '../adapters/flags.js';
import type { TrierarchPaths } from '../adapters/paths.js';

/** `aeolus-trierarch config check`: checks the configuration and prints the effective flags per harness. */
export async function configCheck(paths: TrierarchPaths): Promise<string> {
  const configuration = await loadConfiguration(paths.config);
  return [`The configuration at ${paths.config} fits.`, 'Flags per harness (a want picks option values by name):', describeFlags(configuration)].join('\n');
}
