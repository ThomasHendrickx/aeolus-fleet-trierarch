import { trierarchNameSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { HarnessDetector } from '../core/ports.js';
import type { CommandResult } from './run-command.js';

/**
 * Detecting Codex (#365; docs/trierarch.md, "Detected options"): its own
 * catalog, offline (`codex debug models --bundled`), gives its models. The
 * visible ones are declared, each with `-m`; the default is the model the
 * user's `~/.codex/config.toml` sets at its top level when it is one of them,
 * else the catalog's first. Codex has no effort flag, so no effort is
 * declared.
 */

const catalogSchema = z.object({ models: z.array(z.object({ slug: z.string(), visibility: z.string() })) });

/** The catalog's way of marking a model the picker shows. */
const VISIBLE = 'list';

/** The `model = "..."` of the configuration's top level, before its first table. */
function configuredModelOf(config: string | undefined): string | undefined {
  const topLevel = (config ?? '').split(/^\s*\[/m)[0] ?? '';
  return /^\s*model\s*=\s*"([^"]+)"/m.exec(topLevel)?.[1];
}

function catalogOf(result: CommandResult): z.infer<typeof catalogSchema> | undefined {
  if (result.status !== 0) {
    return undefined;
  }
  try {
    const parsed = catalogSchema.safeParse(JSON.parse(result.stdout));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function createCodexDetector(deps: {
  run: (command: string, options: { args: readonly string[] }) => Promise<CommandResult>;
  /** The user's Codex configuration, `~/.codex/config.toml`; undefined when there is none. */
  readConfig: () => Promise<string | undefined>;
  /** The program to run; `codex` unless a test runs another. */
  program?: string;
}): HarnessDetector {
  const program = deps.program ?? 'codex';
  return {
    version: async () => {
      const result = await deps.run(program, { args: ['--version'] }).catch(() => undefined);
      return result?.status === 0 ? /\S+$/.exec(result.stdout.trim())?.[0] : undefined;
    },
    detect: async ({ version, now }) => {
      const catalog = catalogOf(await deps.run(program, { args: ['debug', 'models', '--bundled'] }));
      const slugs = (catalog?.models ?? []).filter((model) => model.visibility === VISIBLE && trierarchNameSchema.safeParse(model.slug).success).map((model) => model.slug);
      const [first] = slugs;
      if (first === undefined) {
        return undefined;
      }
      const configured = configuredModelOf(await deps.readConfig());
      const values = Object.fromEntries(slugs.map((slug) => [slug, ['-m', slug]]));
      return { version, detectedAt: now, confirmedAt: now, options: { model: { values, default: configured !== undefined && slugs.includes(configured) ? configured : first } } };
    },
  };
}
