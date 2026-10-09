import { trierarchNameSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { ConfiguredOption, HarnessDetector } from '../core/ports.js';
import type { CommandResult } from './run-command.js';

/**
 * Detecting Claude Code (#365; docs/trierarch.md, "Detected options"). Its
 * CLI lists no models, but its --help names the aliases it takes, each for
 * the latest of a family: each is probed once with a short print-mode turn,
 * from a neutral folder and never as a ship, and the exact id it resolves to
 * is read from the answer's modelUsage. Those ids are declared, so they follow
 * the installed CLI with no list to keep. An alias the CLI refuses is left
 * out; one whose probe neither confirms nor refuses it (offline, not logged
 * in) keeps the id it resolved to before at the same version. The effort
 * levels come from --help. Neither has a default: the CLI keeps its own.
 */

/** The longest a probe may take: a CLI that hangs is ended, its id neither confirmed nor refused. */
export const CLAUDE_CODE_PROBE_TIMEOUT_MS = 60_000;

/** The longest --version and --help may take. */
const QUICK_TIMEOUT_MS = 10_000;

/** How Claude Code says it does not know a model. */
const UNRECOGNIZED_MODEL = 'unrecognized_model';
const PROBE_PROMPT = 'Reply OK';

const probeAnswerSchema = z.object({ modelUsage: z.record(z.string(), z.unknown()) });

/** What a probe of an alias found: the exact id it resolved to, a refusal, or neither. */
type Outcome = { kind: 'resolved'; id: string } | { kind: 'refused' } | { kind: 'unknown' };

/** The id the probe ran: the one in modelUsage that names the alias, or the only one. */
function resolvedIdOf(alias: string, modelUsage: Readonly<Record<string, unknown>>): string | undefined {
  const ids = Object.keys(modelUsage).filter((id) => trierarchNameSchema.safeParse(id).success);
  return ids.find((id) => id.includes(alias)) ?? (ids.length === 1 ? ids[0] : undefined);
}

function outcomeOf(alias: string, result: CommandResult): Outcome {
  if (`${result.stdout}\n${result.stderr}`.includes(UNRECOGNIZED_MODEL)) {
    return { kind: 'refused' };
  }
  if (result.status !== 0) {
    return { kind: 'unknown' };
  }
  try {
    const answer = probeAnswerSchema.safeParse(JSON.parse(result.stdout));
    const id = answer.success ? resolvedIdOf(alias, answer.data.modelUsage) : undefined;
    return id === undefined ? { kind: 'unknown' } : { kind: 'resolved', id };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * An option's entry in --help on one line: its own line and the lines its
 * description wraps onto (#383), those indented deeper that start no option.
 */
function entryOf(help: string, flag: string): string {
  const lines = help.split('\n');
  const start = lines.findIndex((line) => line.trimStart().startsWith(flag));
  if (start === -1) {
    return '';
  }
  const indent = (lines[start] ?? '').length - (lines[start] ?? '').trimStart().length;
  const wrapped = lines.slice(start + 1).findIndex((line) => line.length - line.trimStart().length <= indent || line.trimStart().startsWith('-'));
  const end = wrapped === -1 ? lines.length : start + 1 + wrapped;
  return lines
    .slice(start, end)
    .map((line) => line.trim())
    .join(' ');
}

/** The aliases --help names for --model, quoted, such as 'opus'. */
function aliasesOf(help: string): string[] {
  const entry = entryOf(help, '--model <model>');
  return [...entry.matchAll(/'([a-z0-9][a-z0-9._-]*)'/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

/** The levels `--effort <level> ... (low, medium, high)` names in --help, each a value name. */
function effortLevelsOf(help: string): string[] {
  const listed = /\(([^)]*)\)/.exec(entryOf(help, '--effort <level>'))?.[1];
  return (listed ?? '')
    .split(',')
    .map((level) => level.trim())
    .filter((level) => trierarchNameSchema.safeParse(level).success);
}

function optionOf(names: readonly string[], flag: string): ConfiguredOption {
  return { values: Object.fromEntries(names.map((name) => [name, [flag, name]])) };
}

export function createClaudeCodeDetector(deps: {
  run: (command: string, options: { args: readonly string[]; cwd?: string; timeoutMs?: number }) => Promise<CommandResult>;
  /** An empty folder to probe from, so no project's hooks or settings run. */
  neutralFolder: () => Promise<string>;
  /** The program to run; `claude` unless a test runs another. */
  program?: string;
}): HarnessDetector {
  const program = deps.program ?? 'claude';
  return {
    version: async () => {
      const result = await deps.run(program, { args: ['--version'], timeoutMs: QUICK_TIMEOUT_MS }).catch(() => undefined);
      return result?.status === 0 ? /^\S+/.exec(result.stdout.trim())?.[0] : undefined;
    },
    detect: async ({ version, previous, now }) => {
      const help = await deps.run(program, { args: ['--help'], timeoutMs: QUICK_TIMEOUT_MS });
      const text = help.status === 0 ? help.stdout : '';
      const levels = effortLevelsOf(text);
      const aliases = aliasesOf(text);
      const before = previous?.version === version ? previous : undefined;
      const resolvedBefore = Object.keys(before?.options.model?.values ?? {});
      const folder = aliases.length === 0 ? undefined : await deps.neutralFolder();
      const ids: string[] = [];
      let isAnyResolved = false;
      for (const alias of aliases) {
        const outcome = outcomeOf(alias, await deps.run(program, { args: ['-p', '--model', alias, '--max-turns', '1', '--output-format', 'json', PROBE_PROMPT], cwd: folder, timeoutMs: CLAUDE_CODE_PROBE_TIMEOUT_MS }));
        isAnyResolved ||= outcome.kind === 'resolved';
        const kept = outcome.kind === 'resolved' ? [outcome.id] : outcome.kind === 'unknown' ? resolvedBefore.filter((id) => id.includes(alias)) : [];
        ids.push(...kept.filter((id) => !ids.includes(id)));
      }
      return {
        version,
        detectedAt: now,
        confirmedAt: isAnyResolved ? now : (before?.confirmedAt ?? null),
        options: {
          ...(ids.length > 0 && { model: optionOf(ids, '--model') }),
          ...(levels.length > 0 && { effort: optionOf(levels, '--effort') }),
        },
        ...(aliases.length === 0 && {
          problem: `Claude Code ${version}'s --help names no model alias, so this machine declares no Claude Code model until an update of Claude Code names one`,
        }),
      };
    },
  };
}
