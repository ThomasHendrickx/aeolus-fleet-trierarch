import type { TrierarchConfiguration } from '@aeolus-fleet/common';

type HarnessConfiguration = TrierarchConfiguration['harnesses'][string];

/**
 * The flags a launch gets: the harness's own, then each option's value as the
 * want picked it, or its default. A want picks names only; the flags come
 * from the configuration alone.
 */
export function effectiveFlags(harness: HarnessConfiguration, options: Readonly<Record<string, string>>): string[] {
  const picked = Object.entries(harness.options).flatMap(([name, option]) => {
    const value = options[name] ?? option.default;
    return value === undefined ? [] : (option.values[value] ?? []);
  });
  return [...harness.flags, ...picked];
}

/** What `config check` prints: per harness, the flags a want with no options launches with, and each option's values. */
export function describeFlags(configuration: TrierarchConfiguration): string {
  return Object.entries(configuration.harnesses)
    .map(([name, harness]) => {
      const lines = [`${name}: ${[...effectiveFlags(harness, {})].join(' ') || '(no flags)'}`];
      for (const [option, settings] of Object.entries(harness.options)) {
        for (const [value, flags] of Object.entries(settings.values)) {
          const isDefault = settings.default === value;
          lines.push(`  ${option}=${value}${isDefault ? ' (default)' : ''}: ${flags.join(' ') || '(no flags)'}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n');
}
