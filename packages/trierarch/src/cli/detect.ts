import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { DetectHarnesses } from '../core/detect-harnesses.js';
import type { Detected } from '../core/ports.js';

/** What `aeolus-trierarch detect` found, per harness: its version, when its models were last confirmed, and each option's value names. */
export interface DetectReport {
  readonly harnesses: Readonly<Record<string, { version: string; confirmedAt: string | null; options: Readonly<Record<string, readonly string[]>> }>>;
  readonly text: string;
}

/** Per harness, one line: its version, each option with its values and default, and when its models were last confirmed. */
export function describeDetected(at: { harnesses: readonly string[]; detected: Detected }): string {
  return at.harnesses
    .map((name) => {
      const found = at.detected[name];
      if (found === undefined) {
        return `${name}: nothing detected`;
      }
      const options = Object.entries(found.options).map(
        ([option, settings]) => `${option} ${Object.keys(settings.values).map((value) => (value === settings.default ? `${value} (default)` : value)).join(', ')}`,
      );
      const confirmed = found.confirmedAt === null ? 'no model confirmed' : `models confirmed ${found.confirmedAt.toISOString()}`;
      return `${name} ${found.version}: ${options.length === 0 ? 'no options detected' : options.join('; ')}; ${confirmed}`;
    })
    .join('\n');
}

/**
 * `aeolus-trierarch detect` (#365): detects every configured harness again,
 * though its version is the one detected, and gives what it found. A running
 * trierarch reads it at its next start.
 */
export async function detectOptions(at: { configuration: TrierarchConfiguration; detect: DetectHarnesses }): Promise<DetectReport> {
  const harnesses = Object.keys(at.configuration.harnesses);
  const detected = await at.detect({ harnesses, isForced: true });
  return {
    harnesses: Object.fromEntries(
      Object.entries(detected).flatMap(([name, found]) =>
        found === undefined
          ? []
          : [[name, { version: found.version, confirmedAt: found.confirmedAt?.toISOString() ?? null, options: Object.fromEntries(Object.entries(found.options).map(([option, settings]) => [option, Object.keys(settings.values)])) }]],
      ),
    ),
    text: describeDetected({ harnesses, detected }),
  };
}
