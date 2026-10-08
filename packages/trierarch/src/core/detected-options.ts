import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { Detected } from './ports.js';

/**
 * The configuration with each configured harness's detected options added
 * (#365): an option the operator wrote replaces the detected one of its name
 * whole, values and default, so a hand edit is never overwritten and nothing
 * is merged. A detected harness the configuration does not offer is left out.
 */
export function withDetectedOptions(configuration: TrierarchConfiguration, detected: Detected): TrierarchConfiguration {
  const harnesses = Object.fromEntries(
    Object.entries(configuration.harnesses).map(([name, harness]) => [name, { ...harness, options: { ...detected[name]?.options, ...harness.options } }]),
  );
  return { ...configuration, harnesses };
}
