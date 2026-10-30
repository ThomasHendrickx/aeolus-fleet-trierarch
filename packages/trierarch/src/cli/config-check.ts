import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import { describeCommandLine, type CommandPart } from '../adapters/command-line.js';
import { createDetectedFile } from '../adapters/detected-file.js';
import { loadConfiguration, TrierarchFileError } from '../adapters/files.js';
import { describeFlags } from '../adapters/flags.js';
import { effectiveFlags } from '../core/effective-flags.js';
import { adapterFlagsOf, commandLinesOf, type HarnessFiles } from '../adapters/harnesses.js';
import { modelOptionsIgnored, withDetectedOptions } from '../core/detected-options.js';
import { createCheckSessionRuntime } from '../core/check-session-runtime.js';
import type { AdapterFlag, ContainerHostPort } from '../core/ports.js';
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
  /** Where the sessions run: on the host unless the configuration names the container runtime (decision 0039). */
  readonly runtime: NonNullable<TrierarchConfiguration['runtime']>;
  readonly text: string;
}

/** The configuration's session runtime refused, with every reason: config check and the run both say it so. */
export function runtimeRefused(config: string, refusals: readonly string[]): TrierarchFileError {
  return new TrierarchFileError([`The configuration at ${config} cannot run its sessions in containers:`, ...refusals.map((refusal) => `  ${refusal}`)].join('\n'));
}

/** Where the sessions run, in a line. */
function runtimeLine(runtime: ConfigCheckReport['runtime'], modelTokenFile: string): string {
  return runtime.kind === 'host'
    ? 'Sessions run on the host.'
    : `Sessions run in containers of ${runtime.binary}, each capped at ${runtime.memory} of memory and ${String(runtime.cpus)} cpus, with the model token in ${modelTokenFile}.`;
}

/** What config check reads of the machine beside the configuration: the harnesses' own files and what the container runtime needs. */
export interface CheckedMachine {
  readonly files: HarnessFiles;
  readonly host: ContainerHostPort;
}

export async function configCheck(paths: TrierarchPaths, machine: CheckedMachine): Promise<ConfigCheckReport> {
  const { files, host } = machine;
  const configured = await loadConfiguration(paths.config);
  const [withModel, ...more] = modelOptionsIgnored(configured);
  if (withModel !== undefined) {
    // A running trierarch ignores it with a warning; the check says so, so the operator removes it (#382).
    throw new TrierarchFileError(
      `The configuration at ${paths.config} sets a model option for ${[withModel, ...more].join(', ')}: model ids come from detection only (#382), so remove it; aeolus-trierarch detect lists them`,
    );
  }
  const refusals = await createCheckSessionRuntime({ host, modelTokenFile: paths.modelToken })(configured);
  if (refusals.length > 0) {
    throw runtimeRefused(paths.config, refusals);
  }
  const runtime = configured.runtime ?? { kind: 'host' };
  // The detected options too (#365), as the running trierarch has them.
  const detected = await createDetectedFile(paths.detected).load();
  const configuration = withDetectedOptions(configured, detected);
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
            ...(await commandLinesOf({ harness: name, flags, files, permissionModes: detected[name]?.permissionModes })),
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
    runtime,
    text: [
      `The configuration at ${paths.config} fits.`,
      runtimeLine(runtime, paths.modelToken),
      'Flags per harness (settings pick option values by name):',
      describeFlags(configuration),
      '',
      'What each harness launches, with the default options:',
      ...commands,
    ].join('\n'),
  };
}
