import type { TrierarchConfiguration } from '@aeolus-fleet/common';

type HarnessConfiguration = TrierarchConfiguration['harnesses'][string];

/**
 * The flags a launch gets: the harness's own, then each option's value as the
 * settings picked it, or its default. Settings pick names only; the flags come
 * from the configuration alone.
 */
export function effectiveFlags(harness: HarnessConfiguration, options: Readonly<Record<string, string>>): string[] {
  const picked = Object.entries(harness.options).flatMap(([name, option]) => {
    const value = options[name] ?? option.default;
    return value === undefined ? [] : (option.values[value] ?? []);
  });
  return [...harness.flags, ...picked];
}
