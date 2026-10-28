import { z } from 'zod';

import type { PluginHarness } from './plugin.js';

/**
 * Checks an API key with one free call to its harness's vendor, the model list
 * (api keys K11), before `login` writes it. The cause it gives names the
 * vendor's status and error type or code, never the vendor's message: OpenAI's
 * quotes part of the key (K7). Nor a failed request's own message, which
 * quotes a header it could not send: a key that cannot be a header is refused
 * before anything is sent.
 */

export type KeyCheck = { readonly kind: 'taken' } | { readonly kind: 'refused'; readonly cause: string } | { readonly kind: 'unreachable'; readonly cause: string };

interface Vendor {
  readonly name: string;
  readonly url: string;
  readonly headers: (key: string) => Record<string, string>;
}

const ANTHROPIC_VERSION = '2023-06-01';
const CHECK_TIMEOUT_MS = 15_000;

const VENDORS: Readonly<Record<PluginHarness, Vendor>> = {
  'claude-code': { name: 'Anthropic', url: 'https://api.anthropic.com', headers: (key) => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }) },
  codex: { name: 'OpenAI', url: 'https://api.openai.com', headers: (key) => ({ authorization: `Bearer ${key}` }) },
};

/** What an API key is made of: visible ASCII, no space or line break, so it can travel as a header. */
const KEY_PATTERN = /^[\x21-\x7e]+$/u;
/** How Node names why a request found no server, such as ECONNREFUSED. */
const causeSchema = z.object({ cause: z.object({ code: z.string() }) });
/** Both vendors answer an error as `{ error: { type, code? } }`; OpenAI's code is the more precise. */
const errorSchema = z.object({ error: z.object({ type: z.string().optional(), code: z.string().nullish() }) });

export async function checkKey(at: { harness: PluginHarness; key: string; vendorUrl?: string }): Promise<KeyCheck> {
  const vendor = VENDORS[at.harness];
  const url = at.vendorUrl ?? vendor.url;
  if (!KEY_PATTERN.test(at.key)) {
    return { kind: 'refused', cause: 'The key holds a character no API key holds, such as a line break or a space' };
  }
  let response: Response;
  try {
    response = await fetch(`${url}/v1/models`, { headers: vendor.headers(at.key), signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  } catch (error) {
    const code = causeSchema.safeParse(error);
    const reason = code.success ? code.data.cause.code : 'no answer';
    return { kind: 'unreachable', cause: `${vendor.name} could not be reached at ${url} (${reason})` };
  }
  if (response.ok) {
    return { kind: 'taken' };
  }
  const parsed = errorSchema.safeParse(await response.json().catch(() => undefined));
  const errorName = parsed.success ? (parsed.data.error.code ?? parsed.data.error.type) : undefined;
  return { kind: 'refused', cause: `${vendor.name} refused the key: ${String(response.status)}${errorName === undefined ? '' : ` ${errorName}`}` };
}
