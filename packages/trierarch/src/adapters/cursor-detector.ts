import { trierarchNameSchema } from '@aeolus-fleet/common';

import type { DetectedHarness, HarnessDetector } from '../core/ports.js';
import type { CommandResult } from './run-command.js';

/** Cursor's advertised models, without a paid prompt; auto remains available when its model listing cannot run (CC9). */
const QUICK_TIMEOUT_MS = 10_000;
const MODELS_TIMEOUT_MS = 30_000;
const AUTO = 'auto';
const MODEL_LINE = /^([^\s]+) - (.+)$/u;

export function createCursorDetector(deps: {
  run: (command: string, options: { args: readonly string[]; timeoutMs?: number }) => Promise<CommandResult>;
  program?: string;
}): HarnessDetector {
  const program = deps.program ?? 'agent';
  return {
    version: async () => {
      const result = await deps.run(program, { args: ['--version'], timeoutMs: QUICK_TIMEOUT_MS }).catch(() => undefined);
      return result?.status === 0 ? /^\d{4}\.\d{2}\.\d{2}-[a-z0-9]+$/u.exec(result.stdout.trim())?.[0] : undefined;
    },
    detect: async ({ version, now }): Promise<DetectedHarness> => {
      const result = await deps.run(program, { args: ['models'], timeoutMs: MODELS_TIMEOUT_MS }).catch(() => undefined);
      const listed = (result?.status === 0 ? result.stdout : '').split('\n').flatMap((line) => {
        const match = MODEL_LINE.exec(line);
        const id = match?.[1];
        return id !== undefined && trierarchNameSchema.safeParse(id).success ? [{ id, isDefault: match?.[2]?.includes('(default)') === true || match?.[2]?.includes(', default)') === true }] : [];
      });
      const models = [...new Set([...listed.map(({ id }) => id), AUTO])];
      return {
        version,
        detectedAt: now,
        confirmedAt: null,
        options: { model: { values: Object.fromEntries(models.map((id) => [id, ['--model', id]])), default: listed.find(({ isDefault }) => isDefault)?.id ?? AUTO } },
        ...(listed.length === 0 && { problem: `Cursor ${version} names no model in agent models, so this machine declares auto only` }),
      };
    },
  };
}
