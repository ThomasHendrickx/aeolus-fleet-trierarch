import { z } from 'zod';

import type { PluginHarness } from './plugin.js';

/**
 * What a vendor's answer to a request on a key says of the key (api keys K9),
 * as each vendor documents its errors: refused for a key it does not take,
 * out of credit for a billing problem or a spend limit; nothing for a rate
 * limit or a server error, which the harness waits out and retries.
 */

const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYMENT_REQUIRED = 402;

const anthropicSchema = z.object({ error: z.object({ type: z.string(), message: z.string().optional() }) });
const openAiSchema = z.object({ error: z.object({ type: z.string().nullish(), code: z.string().nullish() }) });

/** Anthropic names no code of its own for a spend limit or an empty balance: its messages say it. */
const ANTHROPIC_CREDIT = /credit balance|usage limits|spend limit/iu;
const OPENAI_CREDIT = new Set(['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded']);

function parsed(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function keyStateOfAnswer(answer: { harness: PluginHarness; status: number; body: string }): 'ready' | 'refused' | 'outOfCredit' | undefined {
  const { harness, status } = answer;
  if (status >= 200 && status < 300) {
    return 'ready';
  }
  if (status === HTTP_UNAUTHORIZED) {
    return 'refused';
  }
  if (harness === 'claude-code') {
    const error = anthropicSchema.safeParse(parsed(answer.body)).data?.error;
    return status === HTTP_PAYMENT_REQUIRED || error?.type === 'billing_error' || ANTHROPIC_CREDIT.test(error?.message ?? '') ? 'outOfCredit' : undefined;
  }
  const error = openAiSchema.safeParse(parsed(answer.body)).data?.error;
  return [error?.code, error?.type].some((name) => name !== undefined && name !== null && OPENAI_CREDIT.has(name)) ? 'outOfCredit' : undefined;
}
