import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { z } from 'zod';

import { readKey } from './key-files.js';
import { createKeyStates } from './key-states.js';
import { PLUGIN_HARNESSES, type PluginHarness } from './plugin.js';
import { sessionOfToken } from './proxy-tokens.js';
import { keyStateOfAnswer } from './vendor-answers.js';

/**
 * The model proxy (headless H16, api keys K7): the one process that reads a
 * harness's API key. A session reaches its vendor through it with a token of
 * its own; the proxy takes the token only from a running session of that
 * harness, swaps it for the key, and forwards the request to that harness's
 * vendor alone: `/anthropic/...` to Anthropic for Claude Code, `/openai/...`
 * to OpenAI for Codex. Its refusals name neither a key nor a token. It reads
 * every vendor answer to the key and records what it says of the key (api
 * keys K9): a success as it streams, an error once whole, before it is sent
 * on unchanged.
 */

export interface ModelProxy {
  readonly handle: (request: IncomingMessage, response: ServerResponse) => void;
  /** Checks each key out of credit once (api keys K10), as the proxy does every 15 minutes. */
  readonly checkOutOfCredit: () => Promise<void>;
}

interface Route {
  readonly harness: PluginHarness;
  readonly vendor: string;
  readonly keyHeaders: (key: string) => OutgoingHttpHeaders;
}

const VENDOR_URLS: Readonly<Record<PluginHarness, string>> = { 'claude-code': 'https://api.anthropic.com', codex: 'https://api.openai.com' };
/** The path each harness's base URL ends in, which names its vendor. */
const PREFIXES: Readonly<Record<string, PluginHarness>> = { anthropic: 'claude-code', openai: 'codex' };
/** The proxy's own path, which answers its version. */
export const STATE_PATH = '/aeolus/state';
/** The proxy's own path that checks a harness's key at once, `<path>/<harness>` (login --check, K10). */
export const CHECK_PATH = '/aeolus/check/';
/** How often a key out of credit is checked (K10). */
export const CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** Each vendor's cheapest models, by a word in their ids, cheapest first: the check spends as little as the vendor bills. */
const CHEAPEST: Readonly<Record<PluginHarness, readonly string[]>> = { 'claude-code': ['haiku'], codex: ['nano', 'mini'] };
const ANTHROPIC_VERSION = '2023-06-01';
/** The fewest output tokens the Responses API takes. */
const OPENAI_FEWEST_OUTPUT_TOKENS = 16;
const modelListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
/** What the session sent that never goes on: its own credentials, and what belongs to its connection to the proxy. */
const DROPPED_HEADERS = new Set(['authorization', 'x-api-key', 'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'upgrade']);
const BEARER = /^Bearer (?<token>\S+)$/u;

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;
/** An answer from this status on is an error, read whole before it is sent on. */
const HTTP_ERRORS_FROM = 300;
/** How much of an error's body is read for what it says of the key: a vendor's error is a short JSON object. */
const ERROR_BODY_READ_BYTES = 64 * 1024;

function refuse(response: ServerResponse, refusal: { status: number; message: string }): void {
  const { status, message } = refusal;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ type: 'error', error: { type: status === HTTP_UNAUTHORIZED ? 'authentication_error' : 'not_found_error', message: `aeolus model proxy: ${message}` } }));
}

export function createModelProxy(at: { sessions: string; keys: string; keyStates: string; version: string; vendors?: Partial<Record<PluginHarness, string>>; now?: () => Date }): ModelProxy {
  const keyStates = createKeyStates({ keys: at.keys, file: at.keyStates });
  const now = at.now ?? (() => new Date());
  /** Kept before the answer goes on, so the trierarch knows the key's state by the time the session does; a failed write is tried again on the next answer. */
  const recordAnswer = async (harness: PluginHarness, answer: { status: number; body: string }): Promise<void> => {
    const state = keyStateOfAnswer({ harness, ...answer });
    if (state !== undefined) {
      await keyStates.record(harness, { state, at: now() }).catch(() => undefined);
    }
  };
  const vendorOf = (harness: PluginHarness): string => at.vendors?.[harness] ?? VENDOR_URLS[harness];
  const headersOf = (harness: PluginHarness, key: string): Record<string, string> => (harness === 'claude-code' ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION } : { authorization: `Bearer ${key}` });

  /** One request the vendor bills, on its cheapest model it lists for the key, and what its answer says of the key recorded. */
  const checkKey = async (harness: PluginHarness): Promise<void> => {
    const key = await readKey(at.keys, harness);
    if (key === undefined) {
      return;
    }
    const vendor = vendorOf(harness);
    const listed = modelListSchema.safeParse(await (await fetch(`${vendor}/v1/models`, { headers: headersOf(harness, key) }).catch(() => undefined))?.json().catch(() => undefined));
    const ids = listed.success ? listed.data.data.map((model) => model.id) : [];
    const model = CHEAPEST[harness].flatMap((word) => ids.filter((id) => id.includes(word))).at(0);
    if (model === undefined) {
      return;
    }
    const [path, body] = harness === 'claude-code' ? ['/v1/messages', { model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }] : ['/v1/responses', { model, input: 'Hi', max_output_tokens: OPENAI_FEWEST_OUTPUT_TOKENS }];
    const answer = await fetch(`${vendor}${path}`, { method: 'POST', headers: { ...headersOf(harness, key), 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
    if (answer !== undefined) {
      await recordAnswer(harness, { status: answer.status, body: await answer.text().catch(() => '') });
    }
  };

  const routeOf = (path: string): { route: Route; rest: string } | undefined => {
    const [, prefix = '', ...rest] = path.split('/');
    const harness = PREFIXES[prefix];
    if (harness === undefined) {
      return undefined;
    }
    const vendor = at.vendors?.[harness] ?? VENDOR_URLS[harness];
    const keyHeaders = harness === 'claude-code' ? (key: string) => ({ 'x-api-key': key }) : (key: string) => ({ authorization: `Bearer ${key}` });
    return { route: { harness, vendor, keyHeaders }, rest: `/${rest.join('/')}` };
  };

  const forward = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = request.url ?? '/';
    const checked = PLUGIN_HARNESSES.find((harness) => path === `${CHECK_PATH}${harness}`);
    if (checked !== undefined && request.method === 'POST') {
      if ((await keyStates.stateOf(checked)).state === 'outOfCredit') {
        await checkKey(checked);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(await keyStates.stateOf(checked)));
      return;
    }
    if (path === STATE_PATH) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: at.version }));
      return;
    }
    const routed = routeOf(path);
    if (routed === undefined) {
      refuse(response, { status: HTTP_NOT_FOUND, message: 'it forwards only to the harnesses\' vendors' });
      return;
    }
    const { route, rest } = routed;
    const token = BEARER.exec(request.headers.authorization ?? '')?.groups?.token ?? (typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined);
    const shipId = token === undefined ? undefined : await sessionOfToken(at.sessions, { harness: route.harness, token });
    if (shipId === undefined) {
      refuse(response, { status: HTTP_UNAUTHORIZED, message: 'not the token of a running session of this harness' });
      return;
    }
    const key = await readKey(at.keys, route.harness);
    if (key === undefined) {
      refuse(response, { status: HTTP_UNAUTHORIZED, message: `this computer holds no API key for ${route.harness}` });
      return;
    }
    // The vendor's origin is fixed, and the path only ever set on it: a path is never resolved as a URL, which could name another host.
    const vendorOrigin = new URL(route.vendor).origin;
    const target = new URL(vendorOrigin);
    const queryAt = rest.indexOf('?');
    target.pathname = queryAt === -1 ? rest : rest.slice(0, queryAt);
    target.search = queryAt === -1 ? '' : rest.slice(queryAt);
    if (target.origin !== vendorOrigin) {
      refuse(response, { status: HTTP_NOT_FOUND, message: 'it forwards only to the harnesses\' vendors' });
      return;
    }
    const headers: OutgoingHttpHeaders = { ...Object.fromEntries(Object.entries(request.headers).filter(([name]) => !DROPPED_HEADERS.has(name))), ...route.keyHeaders(key) };
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = send(target, { method: request.method, headers }, (answer) => {
      const status = answer.statusCode ?? HTTP_BAD_GATEWAY;
      const answerHeaders = Object.fromEntries(Object.entries(answer.headers).filter(([name]) => name !== 'connection' && name !== 'transfer-encoding'));
      if (status < HTTP_ERRORS_FROM) {
        answer.pause();
        void recordAnswer(route.harness, { status, body: '' }).then(() => {
          response.writeHead(status, answerHeaders);
          answer.pipe(response);
        });
        return;
      }
      const chunks: Buffer[] = [];
      answer.on('data', (chunk: Buffer) => chunks.push(chunk));
      answer.on('end', () => {
        const body = Buffer.concat(chunks);
        void recordAnswer(route.harness, { status, body: body.subarray(0, ERROR_BODY_READ_BYTES).toString('utf8') }).then(() => {
          response.writeHead(status, answerHeaders);
          response.end(body);
        });
      });
    });
    outgoing.on('error', () => {
      if (!response.headersSent) {
        refuse(response, { status: HTTP_BAD_GATEWAY, message: `${target.host} could not be reached` });
      } else {
        response.destroy();
      }
    });
    request.pipe(outgoing);
  };

  return {
    handle: (request, response) => {
      forward(request, response).catch(() => {
        response.destroy();
      });
    },
    checkOutOfCredit: async () => {
      for (const harness of PLUGIN_HARNESSES) {
        if ((await keyStates.stateOf(harness)).state === 'outOfCredit') {
          await checkKey(harness);
        }
      }
    },
  };
}
