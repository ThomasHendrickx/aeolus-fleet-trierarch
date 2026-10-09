import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { ConfiguredOption, Detected, DetectedHarness } from './ports.js';

/** The option that names the model: its ids come from detection only (#382). */
const MODEL_OPTION = 'model';

/** The detected model option without the ids the machine refused, its default moving to the first id left; none when none is left. */
function offeredModel(found: DetectedHarness): ConfiguredOption | undefined {
  const model = found.options[MODEL_OPTION];
  if (model === undefined) {
    return undefined;
  }
  const refused = new Set((found.refused ?? []).map((each) => each.id));
  const values = Object.fromEntries(Object.entries(model.values).filter(([id]) => !refused.has(id)));
  const [first] = Object.keys(values);
  if (first === undefined) {
    return undefined;
  }
  const isDefaultLeft = model.default !== undefined && model.default in values;
  return { values, ...(model.default !== undefined && { default: isDefaultLeft ? model.default : first }) };
}

/** The options without the model. */
function withoutModel(options: Readonly<Record<string, ConfiguredOption>>): Record<string, ConfiguredOption> {
  return Object.fromEntries(Object.entries(options).filter(([name]) => name !== MODEL_OPTION));
}

/** The detected options of a harness as offered: every one detected, the model without its refused ids. */
function offeredOptions(found: DetectedHarness | undefined): Readonly<Record<string, ConfiguredOption>> {
  if (found === undefined) {
    return {};
  }
  const rest = withoutModel(found.options);
  const model = offeredModel(found);
  return model === undefined ? rest : { [MODEL_OPTION]: model, ...rest };
}

/**
 * The configuration with each configured harness's detected options added
 * (#365): an option the operator wrote replaces the detected one of its name
 * whole, values and default, so a hand edit is never overwritten and nothing
 * is merged. The model is the exception (#382): its ids come from detection
 * only, without the ids the machine refused, so a model the operator wrote is
 * ignored. A detected harness the configuration does not offer is left out.
 */
export function withDetectedOptions(configuration: TrierarchConfiguration, detected: Detected): TrierarchConfiguration {
  const harnesses = Object.fromEntries(
    Object.entries(configuration.harnesses).map(([name, harness]) => [name, { ...harness, options: { ...offeredOptions(detected[name]), ...withoutModel(harness.options) } }]),
  );
  return { ...configuration, harnesses };
}

/** The harnesses whose configuration writes a model option, which is ignored (#382): the operator is told. */
export function modelOptionsIgnored(configuration: TrierarchConfiguration): string[] {
  return Object.entries(configuration.harnesses)
    .filter(([, harness]) => MODEL_OPTION in harness.options)
    .map(([name]) => name);
}
