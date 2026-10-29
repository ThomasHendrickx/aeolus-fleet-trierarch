import { trierarchNameSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { DetectedHarness, HarnessDetector } from '../core/ports.js';
import type { CommandResult } from './run-command.js';

/**
 * Detecting Copilot (docs/trierarch.md, "Detected options"): its version from
 * `copilot --version`, and its models from the model setting `copilot help
 * config` documents, offline, with `auto`, on which Copilot picks the model
 * per request (CC9). No model is probed: every Copilot prompt costs a
 * premium request, so none is confirmed, and a model this login may not use
 * is refused in its session's launch window, as Copilot says it then. The
 * default is the model Copilot's own settings name when it is declared, else
 * `auto`, on which Copilot starts. Copilot has an effort flag, but its levels
 * differ per model, so no effort is declared.
 */

/** The longest --version and the help may take: both are read offline. */
const QUICK_TIMEOUT_MS = 10_000;

const MODEL_FLAG = '--model';
export const AUTO_MODEL = 'auto';

/** The model setting's entry in `copilot help config`, up to the blank line that ends it. */
const MODEL_SETTING = /^ {2}`model`:[^\n]*\n((?: {4}- "[^"]+"\n?)+)/m;
const LISTED_MODEL = /- "([^"]+)"/g;

const settingsSchema = z.object({ model: z.string() });

/** The models the help lists for the model setting, in its order. */
function listedModelsOf(result: CommandResult): string[] {
  const listed = result.status === 0 ? MODEL_SETTING.exec(result.stdout)?.[1] : undefined;
  return [...(listed ?? '').matchAll(LISTED_MODEL)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

/** The model Copilot's settings name, when they are JSON naming one. */
function configuredModelOf(settings: string | undefined): string | undefined {
  try {
    return settingsSchema.safeParse(JSON.parse(settings ?? '')).data?.model;
  } catch {
    // Settings that are no JSON name no model.
    return undefined;
  }
}

export function createCopilotDetector(deps: {
  run: (command: string, options: { args: readonly string[]; timeoutMs?: number }) => Promise<CommandResult>;
  /** Copilot's own settings, `settings.json` in COPILOT_HOME or `~/.copilot`; undefined when there are none. */
  readSettings: () => Promise<string | undefined>;
  /** The program to run; `copilot` unless a test runs another. */
  program?: string;
}): HarnessDetector {
  const program = deps.program ?? 'copilot';
  return {
    version: async () => {
      const result = await deps.run(program, { args: ['--version'], timeoutMs: QUICK_TIMEOUT_MS }).catch(() => undefined);
      // "GitHub Copilot CLI 1.0.105." on its first line.
      return result?.status === 0 ? /(\d+\.\d+\.\d+)/.exec(result.stdout.split('\n')[0] ?? '')?.[1] : undefined;
    },
    detect: async ({ version, now }): Promise<DetectedHarness> => {
      const help = await deps.run(program, { args: ['help', 'config'], timeoutMs: QUICK_TIMEOUT_MS }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
      const listed = listedModelsOf(help).filter((model) => trierarchNameSchema.safeParse(model).success && model !== AUTO_MODEL);
      const models = [...listed, AUTO_MODEL];
      const configured = configuredModelOf(await deps.readSettings());
      const defaultModel = configured !== undefined && models.includes(configured) ? configured : AUTO_MODEL;
      const values = Object.fromEntries(models.map((model) => [model, [MODEL_FLAG, model]]));
      return {
        version,
        detectedAt: now,
        confirmedAt: null,
        options: { model: { values, default: defaultModel } },
        ...(listed.length === 0 && { problem: `Copilot ${version} names no model in copilot help config, so this machine declares auto only` }),
      };
    },
  };
}
