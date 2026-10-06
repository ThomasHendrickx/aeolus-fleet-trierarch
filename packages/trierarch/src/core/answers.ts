import type { TrierarchConfiguration, TrierarchReportDetails } from '@aeolus-fleet/common';

import type { TrierarchState } from './entry.js';
import type { TrierarchSetup } from './ports.js';

/**
 * What describe and list answer (docs/trierarch.md, "The protocol"), from the
 * configuration and the saved state.
 */

/** A harness's options as a JSON Schema: each option one of its value names, with its default when it has one. */
export function optionsSchemaOf(harness: TrierarchConfiguration['harnesses'][string]): TrierarchReportDetails['harnesses'][number]['options'] {
  const properties = Object.fromEntries(
    Object.entries(harness.options).map(([name, option]) => [name, { enum: Object.keys(option.values), ...(option.default !== undefined && { default: option.default }) }]),
  );
  return { type: 'object', properties, additionalProperties: false };
}

export function describedOf(setup: TrierarchSetup, state: TrierarchState): Record<string, unknown> {
  const { configuration, version, adapterFlags } = setup;
  return {
    harnesses: Object.entries(configuration.harnesses).map(([harness, settings]) => ({
      harness,
      options: optionsSchemaOf(settings),
      flags: settings.flags,
      adapterFlags: adapterFlags[harness] ?? [],
    })),
    workspaces: { repositories: Object.keys(configuration.repositories), folders: Object.keys(configuration.folders) },
    caps: configuration.caps,
    kept: state.kept,
    version,
  };
}

export function listedOf(state: TrierarchState): Record<string, unknown> {
  return {
    ships: Object.values(state.entries).map((entry) => ({ shipId: entry.shipId, harness: entry.harness, state: entry.state, since: entry.since, restarts: entry.exits.length })),
    kept: state.kept,
    orphans: state.orphans.map((path) => ({ path })),
  };
}
