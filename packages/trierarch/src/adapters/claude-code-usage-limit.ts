/** Reads a stopped Claude Code turn, keeping its reset wording and stable occurrence for retries. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { UsageLimit } from '../core/ports.js';
import { parsedLine } from './hold-protocol.js';

const eventSchema = z.object({
  rate_limit_info: z.object({ status: z.string(), resetsAt: z.int().min(1).max(253402300799).optional() }).optional(),
  type: z.string(), uuid: z.string().optional(), is_error: z.boolean().optional(), error: z.string().optional(),
  result: z.string().optional(), errors: z.array(z.string()).optional(),
  message: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).optional(),
});
const LIMIT = /you(?:'|’)?ve hit your (?:usage )?limit|usage limit (?:reached|exceeded)/iu;

/** The latest turn's usage-limit error, never ordinary assistant text or an older, recovered stop. */
export function claudeCodeUsageLimitIn(events: readonly string[]): UsageLimit | undefined {
  let limit: UsageLimit | undefined;
  let isPendingLimit = false;
  let reset: string | undefined;
  for (const line of events) {
    const parsed = eventSchema.safeParse(parsedLine(line));
    if (!parsed.success) { continue; }
    const event = parsed.data;
    if (event.type === 'rate_limit_event') {
      if (event.rate_limit_info?.status === 'rejected') {
        reset = event.rate_limit_info.resetsAt === undefined ? undefined : new Date(event.rate_limit_info.resetsAt * 1000).toISOString();
        limit = { occurrence: limit !== undefined && isPendingLimit ? limit.occurrence : event.uuid ?? createHash('sha256').update(line).digest('hex'), reason: `Usage limit reached${reset === undefined ? '' : `; resets at ${reset}`}` };
        isPendingLimit = true;
      }
      continue;
    }
    if (event.type !== 'result' && event.type !== 'assistant' && event.type !== 'user') { continue; }
    const isError = event.type === 'result' ? event.is_error === true : event.type === 'assistant' && event.error === 'rate_limit';
    const reason = isError ? [event.result, ...(event.errors ?? []), ...(event.message?.content.map((block) => block.text) ?? [])].find((text) => text !== undefined && LIMIT.test(text)) : undefined;
    // The assistant error and its following error result are the same stop, even across passes.
    if (isError && isPendingLimit && limit !== undefined) {
      limit = { ...limit, reason: reason === undefined ? limit.reason : `${reason}${reset === undefined ? '' : `; resets at ${reset}`}` };
    } else {
      limit = reason === undefined ? undefined : { occurrence: event.uuid ?? createHash('sha256').update(line).digest('hex'), reason };
    }
    isPendingLimit = event.type === 'assistant' && limit !== undefined;
    if (!isPendingLimit) { reset = undefined; }
  }
  return limit;
}
