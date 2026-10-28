import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { readKey } from './key-files.js';
import type { PluginHarness } from './plugin.js';
import { sessionOfToken } from './proxy-tokens.js';

/**
 * The model proxy (headless H16, api keys K7): the one process that reads a
 * harness's API key. A session reaches its vendor through it with a token of
 * its own; the proxy takes the token only from a running session of that
 * harness, swaps it for the key, and forwards the request to that harness's
 * vendor alone: `/anthropic/...` to Anthropic for Claude Code, `/openai/...`
 * to OpenAI for Codex. Its refusals name neither a key nor a token.
 */

export interface ModelProxy {
  readonly handle: (request: IncomingMessage, response: ServerResponse) => void;
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
/** What the session sent that never goes on: its own credentials, and what belongs to its connection to the proxy. */
const DROPPED_HEADERS = new Set(['authorization', 'x-api-key', 'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'upgrade']);
const BEARER = /^Bearer (?<token>\S+)$/u;

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;

function refuse(response: ServerResponse, refusal: { status: number; message: string }): void {
  const { status, message } = refusal;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ type: 'error', error: { type: status === HTTP_UNAUTHORIZED ? 'authentication_error' : 'not_found_error', message: `aeolus model proxy: ${message}` } }));
}

export function createModelProxy(at: { sessions: string; keys: string; version: string; vendors?: Partial<Record<PluginHarness, string>> }): ModelProxy {
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
      const answerHeaders = Object.fromEntries(Object.entries(answer.headers).filter(([name]) => name !== 'connection' && name !== 'transfer-encoding'));
      response.writeHead(answer.statusCode ?? HTTP_BAD_GATEWAY, answerHeaders);
      answer.pipe(response);
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
  };
}
