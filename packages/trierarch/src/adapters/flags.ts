import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import { effectiveFlags } from '../core/effective-flags.js';

/** What `config check` prints: per harness, the flags settings with no options launch with, and each option's values. */
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
