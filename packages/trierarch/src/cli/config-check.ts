import type { TrierarchAdapterFlag } from '@aeolus-fleet/common';

import { describeCommandLine, type CommandPart } from '../adapters/command-line.js';
import { loadConfiguration } from '../adapters/files.js';
import { describeFlags, effectiveFlags } from '../adapters/flags.js';
import { adapterFlagsOf, commandLinesOf } from '../adapters/harnesses.js';
import type { TrierarchPaths } from '../adapters/paths.js';

/** `aeolus-trierarch config check`: checks the configuration and gives the effective command per harness. */
export interface ConfigCheckReport {
  readonly path: string;
  /**
   * Per harness, the flags a want with no options launches with, each option
   * value's flags, the flags the adapter adds itself, and the command lines
   * of a first start and a restart, each part marked by its source.
   */
  readonly harnesses: Readonly<
    Record<
      string,
      {
        flags: readonly string[];
        options: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
        adapterFlags: readonly TrierarchAdapterFlag[];
        firstStart?: readonly CommandPart[];
        restart?: readonly CommandPart[];
      }
    >
  >;
  readonly text: string;
}

export async function configCheck(paths: TrierarchPaths): Promise<ConfigCheckReport> {
  const configuration = await loadConfiguration(paths.config);
  const adapterFlags = adapterFlagsOf(configuration);
  const harnesses = Object.fromEntries(
    Object.entries(configuration.harnesses).map(([name, harness]) => {
      const flags = effectiveFlags(harness, {});
      return [
        name,
        {
          flags,
          options: Object.fromEntries(Object.entries(harness.options).map(([option, settings]) => [option, settings.values])),
          adapterFlags: adapterFlags[name] ?? [],
          ...commandLinesOf(name, flags),
        },
      ];
    }),
  );
  const commands = Object.entries(harnesses).map(([name, harness]) =>
    harness.firstStart === undefined || harness.restart === undefined
      ? `${name}: this trierarch has no adapter for it`
      : [`${name}:`, `  first start: ${describeCommandLine(harness.firstStart)}`, `  restart: ${describeCommandLine(harness.restart)}`].join('\n'),
  );
  return {
    path: paths.config,
    harnesses,
    text: [
      `The configuration at ${paths.config} fits.`,
      'Flags per harness (a want picks option values by name):',
      describeFlags(configuration),
      '',
      'What each harness launches, with the default options:',
      ...commands,
    ].join('\n'),
  };
}
