import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { ModelTokens, SubscriptionWindow } from '../core/ports.js';
import type { TokenCounts } from '../core/token-cost.js';
import { createAppendedLines } from './appended-lines.js';
import { CLAUDE_CODE_PROBE_TIMEOUT_MS } from './claude-code-detector.js';
import type { CommandResult } from './run-command.js';

/**
 * What Claude Code says of its usage (#353). A ship's tokens come from the
 * transcripts in its projects folder: its folder's conversations and their
 * sub-agents', one line per content block, each line of a message carrying
 * the message's whole usage, so each message counts once by its id. Its
 * subscription comes from the rate limit event a print-mode turn streams,
 * a short turn on the cheapest model, from an empty folder. Claude Code
 * documents neither: the readers are tested on captured ones (test/logs).
 */

const assistantLineSchema = z.object({
  type: z.literal('assistant'),
  timestamp: z.iso.datetime(),
  message: z.object({
    id: z.string(),
    model: z.string(),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), cache_read_input_tokens: z.number().optional(), cache_creation_input_tokens: z.number().optional() }),
  }),
});

/** The model Claude Code names a message it made itself, such as an error, that no model answered. */
const SYNTHETIC_MODEL = '<synthetic>';

const rateLimitEventSchema = z.object({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.object({ unifiedWindows: z.record(z.string(), z.object({ utilization: z.number(), resetsAt: z.number() })) }),
});

/** Claude Code's windows by the name it gives them, in minutes. */
const WINDOW_MINUTES: Readonly<Record<string, number>> = { five_hour: 300, seven_day: 10_080 };

const PROBE_MODEL = 'haiku';
const PROBE_PROMPT = 'Reply OK';
const PERCENT = 100;
const MS_PER_SECOND = 1000;

/** A line's JSON; none for one that is not. */
function jsonOf(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** One transcript as read so far: the messages it counted, and their tokens per model. */
interface TranscriptTotals {
  readonly seen: Set<string>;
  readonly byModel: Map<string, TokenCounts>;
}

function plus(a: TokenCounts | undefined, b: TokenCounts): TokenCounts {
  return a === undefined ? b : { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** The conversations Claude Code keeps of the folder: each `.jsonl` in its projects folder, and the sub-agents' of each. */
async function transcriptsIn(project: string): Promise<string[]> {
  const entries = await readdir(project, { withFileTypes: true }).catch(() => []);
  const own = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => join(project, entry.name));
  const subagents = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const folder = join(project, entry.name, 'subagents');
        return (await readdir(folder).catch(() => [])).filter((name) => name.endsWith('.jsonl')).map((name) => join(folder, name));
      }),
  );
  return [...own, ...subagents.flat()];
}

/** The windows a print-mode turn's stream says, from its last rate limit event; none when it says none. */
function windowsIn(stream: string): SubscriptionWindow[] | undefined {
  const events = stream
    .split('\n')
    .map((line) => rateLimitEventSchema.safeParse(jsonOf(line)))
    .filter((event) => event.success);
  const last = events.at(-1)?.data;
  if (last === undefined) {
    return undefined;
  }
  const windows = Object.entries(last.rate_limit_info.unifiedWindows).flatMap(([name, window]) => {
    const minutes = WINDOW_MINUTES[name];
    const usedPercent = Math.min(PERCENT, Math.max(0, Math.round(window.utilization * PERCENT * PERCENT) / PERCENT));
    return minutes === undefined ? [] : [{ windowMinutes: minutes, usedPercent, resetsAt: new Date(window.resetsAt * MS_PER_SECOND) }];
  });
  return windows.length === 0 ? undefined : windows;
}

export function createClaudeCodeUsage(deps: {
  /** Claude Code's projects folder of the ship: the user's on the host, the ship's own home's in a container. */
  projectsOf: (shipId: ShipId) => string;
  /** When the ship's folder was made: what came before was another crew's. */
  madeAt: (folder: string) => Promise<Date>;
  run: (command: string, options: { args: readonly string[]; cwd?: string; timeoutMs?: number }) => Promise<CommandResult>;
  /** A new empty folder to run the turn from, so no project's hooks or settings apply and it is never a ship; removed after. */
  neutralFolder: () => Promise<string>;
  program?: string;
}) {
  const appended = createAppendedLines();
  const transcripts = new Map<string, TranscriptTotals>();

  const readTranscript = async (path: string, since: Date): Promise<TranscriptTotals> => {
    const { lines, isFromStart } = await appended.read(path);
    const totals = isFromStart ? { seen: new Set<string>(), byModel: new Map<string, TokenCounts>() } : (transcripts.get(path) ?? { seen: new Set<string>(), byModel: new Map<string, TokenCounts>() });
    for (const line of lines) {
      const parsed = assistantLineSchema.safeParse(jsonOf(line));
      if (!parsed.success || parsed.data.message.model === SYNTHETIC_MODEL || totals.seen.has(parsed.data.message.id) || Date.parse(parsed.data.timestamp) < since.getTime()) {
        continue;
      }
      const { id, model, usage } = parsed.data.message;
      totals.seen.add(id);
      totals.byModel.set(model, plus(totals.byModel.get(model), { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 }));
    }
    transcripts.set(path, totals);
    return totals;
  };

  return {
    tokensOf: async (ship: { shipId: ShipId; folder: string }): Promise<ModelTokens[]> => {
      const since = await deps.madeAt(ship.folder);
      const project = join(deps.projectsOf(ship.shipId), ship.folder.replace(/[^a-zA-Z0-9]/gu, '-'));
      const byModel = new Map<string, TokenCounts>();
      for (const path of await transcriptsIn(project)) {
        for (const [model, tokens] of (await readTranscript(path, since)).byModel) {
          byModel.set(model, plus(byModel.get(model), tokens));
        }
      }
      return [...byModel].sort(([a], [b]) => a.localeCompare(b)).map(([model, tokens]) => ({ model, tokens }));
    },
    subscription: async (): Promise<SubscriptionWindow[] | undefined> => {
      const folder = await deps.neutralFolder();
      try {
        const result = await deps.run(deps.program ?? 'claude', {
          args: ['-p', '--model', PROBE_MODEL, '--max-turns', '1', '--output-format', 'stream-json', '--verbose', PROBE_PROMPT],
          cwd: folder,
          timeoutMs: CLAUDE_CODE_PROBE_TIMEOUT_MS,
        });
        return windowsIn(result.stdout);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  };
}
