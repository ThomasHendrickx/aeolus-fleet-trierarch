import { trierarchNameSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { ConfiguredOption, HarnessDetector } from '../core/ports.js';
import type { CommandResult } from './run-command.js';

/**
 * Detecting Claude Code (#365; docs/trierarch.md, "Detected options"). Its
 * CLI lists no models, so the trierarch ships the ids it knows and confirms
 * each with one short print-mode turn, from a neutral folder and never as a
 * ship. An id the CLI refuses as unrecognized is left out; one whose probe
 * neither confirms nor refuses it (offline, not logged in) is declared only
 * when it was confirmed before at the same version. The effort levels come
 * from --help. Neither has a default: the CLI keeps its own.
 */

/** The model ids this trierarch knows for Claude Code, each confirmed by a probe before it is declared. */
export const CLAUDE_CODE_KNOWN_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'] as const;

/** How Claude Code says it does not know a model. */
const UNRECOGNIZED_MODEL = 'unrecognized_model';
const PROBE_PROMPT = 'Reply OK';

const probeAnswerSchema = z.object({ modelUsage: z.record(z.string(), z.unknown()) });

type Outcome = 'confirmed' | 'refused' | 'unknown';

function outcomeOf(id: string, result: CommandResult): Outcome {
  if (`${result.stdout}\n${result.stderr}`.includes(UNRECOGNIZED_MODEL)) {
    return 'refused';
  }
  if (result.status !== 0) {
    return 'unknown';
  }
  try {
    const answer = probeAnswerSchema.safeParse(JSON.parse(result.stdout));
    return answer.success && id in answer.data.modelUsage ? 'confirmed' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The levels `--effort <level> ... (low, medium, high)` names in --help, each a value name. */
function effortLevelsOf(help: string): string[] {
  const listed = /--effort <level>[^\n(]*\(([^)]*)\)/.exec(help)?.[1];
  return (listed ?? '')
    .split(',')
    .map((level) => level.trim())
    .filter((level) => trierarchNameSchema.safeParse(level).success);
}

function optionOf(names: readonly string[], flag: string): ConfiguredOption {
  return { values: Object.fromEntries(names.map((name) => [name, [flag, name]])) };
}

export function createClaudeCodeDetector(deps: {
  run: (command: string, options: { args: readonly string[]; cwd?: string }) => Promise<CommandResult>;
  /** An empty folder to probe from, so no project's hooks or settings run. */
  neutralFolder: () => Promise<string>;
  /** The program to run; `claude` unless a test runs another. */
  program?: string;
}): HarnessDetector {
  const program = deps.program ?? 'claude';
  return {
    version: async () => {
      const result = await deps.run(program, { args: ['--version'] }).catch(() => undefined);
      return result?.status === 0 ? /^\S+/.exec(result.stdout.trim())?.[0] : undefined;
    },
    detect: async ({ version, previous, now }) => {
      const help = await deps.run(program, { args: ['--help'] });
      const levels = help.status === 0 ? effortLevelsOf(help.stdout) : [];
      const folder = await deps.neutralFolder();
      const before = previous?.version === version ? previous : undefined;
      const confirmedBefore = Object.keys(before?.options.model?.values ?? {});
      const ids: string[] = [];
      let isAnyConfirmed = false;
      for (const id of CLAUDE_CODE_KNOWN_MODELS) {
        const outcome = outcomeOf(id, await deps.run(program, { args: ['-p', '--model', id, '--max-turns', '1', '--output-format', 'json', PROBE_PROMPT], cwd: folder }));
        isAnyConfirmed ||= outcome === 'confirmed';
        if (outcome === 'confirmed' || (outcome === 'unknown' && confirmedBefore.includes(id))) {
          ids.push(id);
        }
      }
      return {
        version,
        detectedAt: now,
        confirmedAt: isAnyConfirmed ? now : (before?.confirmedAt ?? null),
        options: {
          ...(ids.length > 0 && { model: optionOf(ids, '--model') }),
          ...(levels.length > 0 && { effort: optionOf(levels, '--effort') }),
        },
      };
    },
  };
}
