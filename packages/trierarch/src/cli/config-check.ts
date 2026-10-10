import { describeCommandLine, type CommandPart } from '../adapters/command-line.js';
import { createDetectedFile } from '../adapters/detected-file.js';
import { loadConfiguration, TrierarchFileError } from '../adapters/files.js';
import { describeFlags } from '../adapters/flags.js';
import { effectiveFlags } from '../core/effective-flags.js';
import { adapterFlagsOf, commandLinesOf, type HarnessFiles } from '../adapters/harnesses.js';
import { modelOptionsIgnored, withDetectedOptions } from '../core/detected-options.js';
import type { AdapterFlag } from '../core/ports.js';
import type { TrierarchPaths } from '../adapters/paths.js';

/** `aeolus-trierarch config check`: checks the configuration and gives the effective command per harness. */
export interface ConfigCheckReport {
  readonly path: string;
  /**
   * Per harness, the flags settings with no options launch with, each option
   * value's flags, the flags the adapter adds itself, and the command lines
   * of a first start and a restart, each part marked by its source.
   */
  readonly harnesses: Readonly<
    Record<
      string,
      {
        flags: readonly string[];
        options: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
        adapterFlags: readonly AdapterFlag[];
        firstStart?: readonly CommandPart[];
        restart?: readonly CommandPart[];
      }
    >
  >;
  readonly text: string;
}

export async function configCheck(paths: TrierarchPaths, files: HarnessFiles): Promise<ConfigCheckReport> {
  const configured = await loadConfiguration(paths.config);
  const [withModel, ...more] = modelOptionsIgnored(configured);
  if (withModel !== undefined) {
    // A running trierarch ignores it with a warning; the check says so, so the operator removes it (#382).
    throw new TrierarchFileError(
      `The configuration at ${paths.config} sets a model option for ${[withModel, ...more].join(', ')}: model ids come from detection only (#382), so remove it; aeolus-trierarch detect lists them`,
    );
  }
  // The detected options too (#365), as the running trierarch has them.
  const configuration = withDetectedOptions(configured, await createDetectedFile(paths.detected).load());
  const adapterFlags = adapterFlagsOf(configuration);
  const harnesses = Object.fromEntries(
    await Promise.all(
      Object.entries(configuration.harnesses).map(async ([name, harness]) => {
        const flags = effectiveFlags(harness, {});
        return [
          name,
          {
            flags,
            options: Object.fromEntries(Object.entries(harness.options).map(([option, settings]) => [option, settings.values])),
            adapterFlags: adapterFlags[name] ?? [],
            ...(await commandLinesOf({ harness: name, flags, files })),
          },
        ] as const;
      }),
    ),
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
      'Flags per harness (settings pick option values by name):',
      describeFlags(configuration),
      '',
      'What each harness launches, with the default options:',
      ...commands,
    ].join('\n'),
  };
}
