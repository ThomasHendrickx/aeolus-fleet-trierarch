import { trierarchNameSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { DetectedHarness, HarnessDetector } from '../core/ports.js';
import type { CommandResult } from './run-command.js';

/**
 * Detecting Codex (#365; docs/trierarch.md, "Detected options"): its own
 * catalog names its models, the one it runs with now (`codex debug models`),
 * else the bundled one (`--bundled`), offline. The catalog says what Codex
 * knows, not what this login may use (#392): each of its models, hidden ones
 * included, is probed once with a short non-interactive turn, from a neutral
 * folder and never as a ship, and only the ones it confirms are declared,
 * each with `-m`. A model whose probe neither confirms nor refuses it
 * (offline, timed out) keeps what was confirmed before at the same version.
 * The default is the model the user's `~/.codex/config.toml` sets at its top
 * level when confirmed, else the first confirmed model the catalog shows;
 * none is declared without one. Codex has no effort flag, so no effort is
 * declared.
 */

const catalogSchema = z.object({ models: z.array(z.object({ slug: z.string(), visibility: z.string() })) });

/** The longest --version and the catalog may take: both are read offline. */
const QUICK_TIMEOUT_MS = 10_000;

/** The longest a probe may take: a CLI that hangs is ended, its model neither confirmed nor refused. */
export const CODEX_PROBE_TIMEOUT_MS = 60_000;

const PROBE_PROMPT = 'Reply OK';

/** The catalog's way of marking a model the picker shows. */
const VISIBLE = 'list';

/** How Codex says this login may not use a model, as codex-cli 0.160.1 answers it. */
const REFUSALS = ['invalid_request_error', 'model is not supported'];

/** What a probe of a model found: confirmed, refused, or neither. */
type Outcome = 'confirmed' | 'refused' | 'unknown';

function outcomeOf(result: CommandResult): Outcome {
  const said = `${result.stdout}\n${result.stderr}`;
  if (REFUSALS.some((refusal) => said.includes(refusal))) {
    return 'refused';
  }
  return result.status === 0 ? 'confirmed' : 'unknown';
}

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
  run: (command: string, options: { args: readonly string[]; cwd?: string; timeoutMs?: number }) => Promise<CommandResult>;
  /** The user's Codex configuration, `config.toml` in CODEX_HOME or `~/.codex`; undefined when there is none. */
  readConfig: () => Promise<string | undefined>;
  /** An empty folder to probe from, so no project's instructions or settings apply. */
  neutralFolder: () => Promise<string>;
  /** The program to run; `codex` unless a test runs another. */
  program?: string;
}): HarnessDetector {
  const program = deps.program ?? 'codex';
  return {
    version: async () => {
      const result = await deps.run(program, { args: ['--version'], timeoutMs: QUICK_TIMEOUT_MS }).catch(() => undefined);
      return result?.status === 0 ? /\S+$/.exec(result.stdout.trim())?.[0] : undefined;
    },
    detect: async ({ version, previous, now }): Promise<DetectedHarness | undefined> => {
      const catalog =
        catalogOf(await deps.run(program, { args: ['debug', 'models'], timeoutMs: QUICK_TIMEOUT_MS })) ??
        catalogOf(await deps.run(program, { args: ['debug', 'models', '--bundled'], timeoutMs: QUICK_TIMEOUT_MS }));
      const models = (catalog?.models ?? []).filter((model) => trierarchNameSchema.safeParse(model.slug).success);
      if (models.length === 0) {
        return undefined;
      }
      const before = previous?.version === version ? previous : undefined;
      const confirmedBefore = new Set(Object.keys(before?.options.model?.values ?? {}));
      const folder = await deps.neutralFolder();
      const confirmed: string[] = [];
      let isAnyConfirmed = false;
      for (const { slug } of models) {
        const outcome = outcomeOf(
          await deps.run(program, { args: ['exec', '--skip-git-repo-check', '-m', slug, PROBE_PROMPT], cwd: folder, timeoutMs: CODEX_PROBE_TIMEOUT_MS }).catch(() => ({ status: 1, stdout: '', stderr: '' })),
        );
        isAnyConfirmed ||= outcome === 'confirmed';
        if (outcome === 'confirmed' || (outcome === 'unknown' && confirmedBefore.has(slug))) {
          confirmed.push(slug);
        }
      }
      const confirmedAt = isAnyConfirmed ? now : (before?.confirmedAt ?? null);
      if (confirmed.length === 0) {
        return { version, detectedAt: now, confirmedAt, options: {}, problem: `Codex ${version} confirmed none of its catalog's models for this login, so this machine declares no Codex model` };
      }
      const configured = configuredModelOf(await deps.readConfig());
      const shown = models.filter((model) => model.visibility === VISIBLE).map((model) => model.slug);
      const defaultModel = configured !== undefined && confirmed.includes(configured) ? configured : shown.find((slug) => confirmed.includes(slug));
      const values = Object.fromEntries(confirmed.map((slug) => [slug, ['-m', slug]]));
      return { version, detectedAt: now, confirmedAt, options: { model: { values, ...(defaultModel !== undefined && { default: defaultModel }) } } };
    },
  };
}
