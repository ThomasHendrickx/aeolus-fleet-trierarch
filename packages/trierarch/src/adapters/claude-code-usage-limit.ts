/** Reads a stopped Claude Code turn, keeping its reset wording and stable occurrence for retries. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { UsageLimit } from '../core/ports.js';
import { parsedLine } from './hold-protocol.js';

const eventSchema = z.object({
  type: z.string(), uuid: z.string().optional(), is_error: z.boolean().optional(), error: z.string().optional(),
  result: z.string().optional(), errors: z.array(z.string()).optional(),
  message: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).optional(),
});
const LIMIT = /you(?:'|’)?ve hit your (?:usage )?limit|usage limit (?:reached|exceeded)/iu;

/** The latest turn's usage-limit error, never ordinary assistant text or an older, recovered stop. */
export function claudeCodeUsageLimitIn(events: readonly string[]): UsageLimit | undefined {
  let limit: UsageLimit | undefined;
  let isAssistantLimit = false;
  for (const line of events) {
    const parsed = eventSchema.safeParse(parsedLine(line));
    if (!parsed.success) { continue; }
    const event = parsed.data;
    if (event.type !== 'result' && event.type !== 'assistant' && event.type !== 'user') { continue; }
    const isError = event.type === 'result' ? event.is_error === true : event.type === 'assistant' && event.error === 'rate_limit';
    const reason = isError ? [event.result, ...(event.errors ?? []), ...(event.message?.content.map((block) => block.text) ?? [])].find((text) => text !== undefined && LIMIT.test(text)) : undefined;
    // The assistant error and its following error result are the same stop, even across passes.
    if (isError && event.type === 'result' && isAssistantLimit && limit !== undefined) {
      limit = { ...limit, reason: reason ?? limit.reason };
    } else {
      limit = reason === undefined ? undefined : { occurrence: event.uuid ?? createHash('sha256').update(line).digest('hex'), reason };
    }
    isAssistantLimit = event.type === 'assistant' && limit !== undefined;
  }
  return limit;
}
