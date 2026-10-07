import type { TrierarchConfiguration, TrierarchReportDetails } from '@aeolus-fleet/common';

/**
 * A harness's options as a JSON Schema, as the trierarch's report details
 * give it (docs/trierarch.md, "What a trierarch reports"): each option one of
 * its value names, with its default when it has one.
 */
export function optionsSchemaOf(harness: TrierarchConfiguration['harnesses'][string]): TrierarchReportDetails['harnesses'][number]['options'] {
  const properties = Object.fromEntries(
    Object.entries(harness.options).map(([name, option]) => [name, { enum: Object.keys(option.values), ...(option.default !== undefined && { default: option.default }) }]),
  );
  return { type: 'object', properties, additionalProperties: false };
}
