import type { TrierarchConfiguration } from '@aeolus-fleet/common';

/**
 * Remote Control (headless H3, H20): a session the trierarch runs has no
 * terminal, so it has no Remote Control. `--remote-control` in a harness's
 * flags is refused on every runtime, and an upgrade takes it out of the
 * configuration, so a machine that carried it keeps crewing.
 */

export const REMOTE_CONTROL = '--remote-control';

/** Whether a flag is Remote Control's, with or without a name given with `=`. */
export function isRemoteControl(flag: string): boolean {
  return flag === REMOTE_CONTROL || flag.startsWith(`${REMOTE_CONTROL}=`);
}

/** The flags without Remote Control's, and the name given after it, a word that is no flag. */
function flagsWithout(flags: readonly string[]): string[] {
  return flags.filter((flag, at) => !isRemoteControl(flag) && !(flags[at - 1] === REMOTE_CONTROL && !flag.startsWith('-')));
}

/** The configuration with no Remote Control in any harness's flags or option values, and the harnesses it was in. */
export function withoutRemoteControl(configuration: TrierarchConfiguration): { configuration: TrierarchConfiguration; harnesses: string[] } {
  const harnesses: string[] = [];
  const changed = Object.fromEntries(
    Object.entries(configuration.harnesses).map(([name, harness]) => {
      const launched = [...harness.flags, ...Object.values(harness.options).flatMap((option) => Object.values(option.values).flat())];
      if (!launched.some(isRemoteControl)) {
        return [name, harness];
      }
      harnesses.push(name);
      const options = Object.fromEntries(Object.entries(harness.options).map(([option, settings]) => [option, { ...settings, values: Object.fromEntries(Object.entries(settings.values).map(([value, flags]) => [value, flagsWithout(flags)])) }]));
      return [name, { ...harness, flags: flagsWithout(harness.flags), options }];
    }),
  );
  return { configuration: harnesses.length === 0 ? configuration : { ...configuration, harnesses: changed }, harnesses };
}
