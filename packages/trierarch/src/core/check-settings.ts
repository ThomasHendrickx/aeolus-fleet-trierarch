import { crewSettingsSchema, type CrewSettings, type ShipId, type TrierarchConfiguration } from '@aeolus-fleet/common';

import type { TrierarchState } from './entry.js';
import { err, ok, type Result } from './shared/result.js';

/** Why the trierarch cannot crew settings: the field at fault, when one is, and a reason argo can read. */
export interface Refusal {
  readonly field?: string;
  readonly reason: string;
}

/** Settings this trierarch can crew: parsed, with the harness it crews them with and each option resolved to its value name. */
export interface CheckedSettings {
  readonly settings: CrewSettings;
  /** The harness the settings name, or without one this trierarch's default: the first in its configuration (#343). */
  readonly harness: string;
  readonly options: Readonly<Record<string, string>>;
}

/** The field an issue names, as `options.model`, when it names one. */
function fieldOf(path: readonly PropertyKey[]): { field?: string } {
  return path.length === 0 ? {} : { field: path.map(String).join('.') };
}

/**
 * Checks a crew request's settings again before crewing (decision 0027):
 * the crew settings schema, then what this trierarch's configuration offers
 * (harness, repository or folder, each option and its value), and one folder
 * per ship. The trierarch plugin checked them already; this machine's
 * configuration may have changed since.
 */
export function checkSettings(raw: unknown, context: { shipId: ShipId; configuration: TrierarchConfiguration; state: TrierarchState }): Result<CheckedSettings, Refusal> {
  const parsed = crewSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return err({ ...fieldOf(issue?.path ?? []), reason: issue?.message ?? 'The settings do not parse' });
  }
  const settings = parsed.data;
  const { configuration, state, shipId } = context;
  const harnessName = settings.harness ?? Object.keys(configuration.harnesses)[0];
  const harness = harnessName === undefined ? undefined : configuration.harnesses[harnessName];
  if (harnessName === undefined || harness === undefined) {
    return err({ field: 'harness', reason: settings.harness === undefined ? 'This trierarch offers no harness' : `This trierarch offers no harness ${settings.harness}` });
  }
  const { workspace } = settings;
  if (workspace.kind === 'worktree' && !(workspace.repository in configuration.repositories)) {
    return err({ field: 'workspace.repository', reason: `This trierarch offers no repository ${workspace.repository}` });
  }
  if (workspace.kind === 'folder') {
    if (!(workspace.name in configuration.folders)) {
      return err({ field: 'workspace.name', reason: `This trierarch offers no folder ${workspace.name}` });
    }
    const crewing = Object.values(state.entries).find((entry) => entry.shipId !== shipId && entry.workspace.kind === 'folder' && entry.workspace.name === workspace.name);
    if (crewing !== undefined) {
      return err({ field: 'workspace.name', reason: `The folder ${workspace.name} crews ${crewing.shipId} already: one folder crews one ship` });
    }
  }
  const options: Record<string, string> = {};
  for (const [name, value] of Object.entries(settings.options)) {
    const option = harness.options[name];
    if (option === undefined) {
      // An option the harness does not declare is ignored: no flag, no refusal (#366).
      continue;
    }
    if (typeof value !== 'string' || !(value in option.values)) {
      return err({ field: `options.${name}`, reason: `${name} must be one of ${Object.keys(option.values).join(', ')}` });
    }
    options[name] = value;
  }
  return ok({ settings, harness: harnessName, options });
}
