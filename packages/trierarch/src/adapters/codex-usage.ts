import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { ModelTokens, SubscriptionWindow } from '../core/ports.js';
import type { TokenCounts } from '../core/token-cost.js';
import { createAppendedLines } from './appended-lines.js';

/**
 * What Codex says of its usage (#353), from its session logs (rollout files
 * under `sessions/<year>/<month>/<day>/`). A session log starts with the
 * folder it ran in; each turn names its model, and each token count the
 * session's total so far, so a turn's tokens are what the total grew by since
 * the count before. Codex's input counts what it read from the cache: the
 * input here is without it. Each token count also says how much of the
 * subscription's windows is used: the newest log's last one is read. Codex
 * documents no format for them: the reader is tested on a captured one (test/logs).
 */

const metaSchema = z.object({ type: z.literal('session_meta'), payload: z.object({ timestamp: z.iso.datetime(), cwd: z.string() }) });

const turnSchema = z.object({ type: z.literal('turn_context'), payload: z.object({ model: z.string() }) });

const totalSchema = z.object({ input_tokens: z.number(), cached_input_tokens: z.number().optional(), cache_write_input_tokens: z.number().optional(), output_tokens: z.number() });

const tokenCountSchema = z.object({
  type: z.literal('event_msg'),
  payload: z.object({ type: z.literal('token_count'), info: z.object({ total_token_usage: totalSchema }).nullable().optional() }),
});

const windowSchema = z.object({ used_percent: z.number(), window_minutes: z.number(), resets_at: z.number() });

const rateLimitsSchema = z.object({
  type: z.literal('event_msg'),
  payload: z.object({ type: z.literal('token_count'), rate_limits: z.object({ primary: windowSchema.nullable().optional(), secondary: windowSchema.nullable().optional() }) }),
});

const PERCENT = 100;
const MS_PER_SECOND = 1000;
/** How many of the newest session logs are searched for the subscription's windows. */
const NEWEST_LOGS_SEARCHED = 10;

type Total = z.infer<typeof totalSchema>;

const NONE: Total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 };

/** One session log as read so far: the folder it ran in and since when, the model of its turn now, its last total, and its tokens per model. */
interface SessionLog {
  folder?: string;
  startedAt?: number;
  model?: string;
  total: Total;
  readonly byModel: Map<string, TokenCounts>;
}

function jsonOf(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function plus(a: TokenCounts | undefined, b: TokenCounts): TokenCounts {
  return a === undefined ? b : { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** What the session's total grew by, input without what was read from or written to the cache. */
function grownBy(now: Total, before: Total): TokenCounts {
  const cacheRead = (now.cached_input_tokens ?? 0) - (before.cached_input_tokens ?? 0);
  const cacheWrite = (now.cache_write_input_tokens ?? 0) - (before.cache_write_input_tokens ?? 0);
  return { input: Math.max(0, now.input_tokens - before.input_tokens - cacheRead - cacheWrite), output: now.output_tokens - before.output_tokens, cacheRead, cacheWrite };
}

function read(log: SessionLog, line: string): void {
  const json = jsonOf(line);
  const meta = metaSchema.safeParse(json);
  if (meta.success) {
    log.folder = meta.data.payload.cwd;
    log.startedAt = Date.parse(meta.data.payload.timestamp);
    return;
  }
  const turn = turnSchema.safeParse(json);
  if (turn.success) {
    log.model = turn.data.payload.model;
    return;
  }
  const total = tokenCountSchema.safeParse(json).data?.payload.info?.total_token_usage;
  if (total !== undefined && log.model !== undefined) {
    log.byModel.set(log.model, plus(log.byModel.get(log.model), grownBy(total, log.total)));
    log.total = total;
  }
}

export function createCodexUsage(deps: {
  /** Codex's sessions folder: `sessions` in CODEX_HOME, or in `~/.codex`. */
  sessions: string;
  /** When the ship's folder was made: what came before was another crew's. */
  madeAt: (folder: string) => Promise<Date>;
}) {
  const appended = createAppendedLines();
  const logs = new Map<string, SessionLog>();

  /** Every session log, oldest first, as their names start with when they started. */
  const sessionLogs = async (): Promise<string[]> => {
    const names = await readdir(deps.sessions, { recursive: true }).catch(() => []);
    return names
      .filter((name) => /(^|\/)rollout-[^/]*\.jsonl$/u.test(name))
      .map((name) => join(deps.sessions, name))
      .sort((a, b) => a.localeCompare(b));
  };

  return {
    tokensOf: async (ship: { shipId: ShipId; folder: string }): Promise<ModelTokens[]> => {
      const since = (await deps.madeAt(ship.folder)).getTime();
      const byModel = new Map<string, TokenCounts>();
      for (const path of await sessionLogs()) {
        // A log not written since the folder was made is another crew's: never read.
        if ((await stat(path)).mtimeMs < since) {
          continue;
        }
        const { lines, isFromStart } = await appended.read(path);
        const log = (isFromStart ? undefined : logs.get(path)) ?? { total: NONE, byModel: new Map<string, TokenCounts>() };
        lines.forEach((line) => {
          read(log, line);
        });
        logs.set(path, log);
        if (log.folder === ship.folder && (log.startedAt ?? 0) >= since) {
          for (const [model, tokens] of log.byModel) {
            byModel.set(model, plus(byModel.get(model), tokens));
          }
        }
      }
      return [...byModel].sort(([a], [b]) => a.localeCompare(b)).map(([model, tokens]) => ({ model, tokens }));
    },
    subscription: async (): Promise<SubscriptionWindow[] | undefined> => {
      for (const path of (await sessionLogs()).slice(-NEWEST_LOGS_SEARCHED).reverse()) {
        const last = (await readFile(path, 'utf8'))
          .split('\n')
          .map((line) => rateLimitsSchema.safeParse(jsonOf(line)).data?.payload.rate_limits)
          .filter((limits) => limits !== undefined)
          .at(-1);
        if (last !== undefined) {
          return [last.primary, last.secondary]
            .filter((window) => window !== undefined && window !== null)
            .map((window) => ({ windowMinutes: window.window_minutes, usedPercent: Math.min(PERCENT, Math.max(0, window.used_percent)), resetsAt: new Date(window.resets_at * MS_PER_SECOND) }));
        }
      }
      return undefined;
    },
  };
}
