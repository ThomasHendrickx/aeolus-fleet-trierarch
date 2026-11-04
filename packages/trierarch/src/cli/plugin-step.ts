import { z } from 'zod';

import type { CommandResult } from '../adapters/run-command.js';

/** What upgrade says on the version it runs already, which the plugin step of an upgrade leaves out. */
export function alreadyOn(version: string): string {
  return `The trierarch is already on ${version}.`;
}

/** What the installed version's `upgrade --json` says that the plugin step needs. */
const installedReportSchema = z.object({ isPluginUpdated: z.boolean(), said: z.array(z.string()) });

/** The plugin step as the installed version ran it, from what its upgrade at its own version answered (#725). */
export function pluginStepOf(answer: CommandResult, version: string): { isPluginUpdated: boolean; said: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(answer.stdout);
  } catch {
    raw = undefined;
  }
  const parsed = installedReportSchema.safeParse(raw);
  if (!parsed.success) {
    const output = `${answer.stdout}${answer.stderr}`.trim();
    return { isPluginUpdated: false, said: [`The aeolus-fleet plugin was not updated: the trierarch ${version} said ${output}. Fix what it says, then run aeolus-trierarch upgrade again.`] };
  }
  return { isPluginUpdated: parsed.data.isPluginUpdated, said: parsed.data.said.filter((line) => line !== alreadyOn(version)) };
}
