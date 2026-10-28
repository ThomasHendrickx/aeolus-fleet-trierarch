import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { createKeyFiles } from './key-files.js';
import { createModelProxy } from './model-proxy.js';
import { createKeyStates } from './key-states.js';
import { writeProxyToken } from './proxy-tokens.js';

/** Made-up secrets: no test holds a real one. */
const ANTHROPIC_KEY = 'test-anthropic-key-not-real';
const OPENAI_KEY = 'test-openai-key-not-real';
const TOKEN = 'test-session-token-one';
const AT = new Date('2026-10-28T14:02:00.000Z');
const keys = () => createKeyFiles(join(home, 'keys'));
const keyStatesFile = () => join(home, 'proxy', 'key-states.json');
const keyStateOf = (harness: 'claude-code' | 'codex') => createKeyStates({ keys: join(home, 'keys'), file: keyStatesFile() }).stateOf(harness);
/** A pid no process has: the hold of a stopped session. */
const GONE_PID = 2_147_483_000;

interface Asked {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let home: string;
let sessions: string;
let servers: Server[];
let vendor: { url: string; asked: Asked[] };
let proxyUrl: string;
let proxy: ReturnType<typeof createModelProxy>;
/** What the vendor answers: a success naming the path it was asked, unless a test sets otherwise. */
let vendorAnswer: { status: number; body: string } | undefined;

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return `http://127.0.0.1:${String(port)}`;
}

/** A vendor that answers 200 with a body naming the path it was asked, and keeps every request. */
async function aVendor(): Promise<{ url: string; asked: Asked[] }> {
  const asked: Asked[] = [];
  const url = await listen(
    createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        asked.push({ method: request.method, path: request.url, headers: request.headers, body });
        if (request.url === '/v1/models') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }, { id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }, { id: 'gpt-5.5-nano' }] }));
          return;
        }
        response.writeHead(vendorAnswer?.status ?? 200, { 'content-type': 'application/json' });
        response.end(vendorAnswer?.body ?? JSON.stringify({ answered: request.url }));
      });
    }),
  );
  return { url, asked };
}

/** A session of the harness whose hold runs (this test's own pid) or has gone. */
async function aSession(at: { harness: 'claude-code' | 'codex'; token: string; isRunning?: boolean }): Promise<void> {
  const shipId = newId('ship');
  const folder = join(sessions, shipId);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'hold.pid'), String(at.isRunning === false ? GONE_PID : process.pid));
  await writeProxyToken(folder, { harness: at.harness, token: at.token });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-proxy-'));
  sessions = join(home, 'sessions');
  mkdirSync(sessions);
  servers = [];
  vendorAnswer = undefined;
  vendor = await aVendor();
  const keys = createKeyFiles(join(home, 'keys'));
  await keys.write('claude-code', ANTHROPIC_KEY);
  await keys.write('codex', OPENAI_KEY);
  proxy = createModelProxy({ sessions, keys: join(home, 'keys'), keyStates: keyStatesFile(), version: '0.34.0', vendors: { 'claude-code': vendor.url, codex: vendor.url }, now: () => AT });
  proxyUrl = await listen(createServer(proxy.handle));
});

afterEach(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  rmSync(home, { recursive: true, force: true });
});

function ask(path: string, at: { token?: string; body?: string } = {}): Promise<Response> {
  return fetch(`${proxyUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(at.token !== undefined && { authorization: `Bearer ${at.token}` }) }, body: at.body ?? '{}' });
}

describe('the model proxy', () => {
  it("forwards a running Claude Code session's request to Anthropic with the key, never its own token (headless H16, api keys K7)", async () => {
    await aSession({ harness: 'claude-code', token: TOKEN });

    const answer = await ask('/anthropic/v1/messages?beta=true', { token: TOKEN, body: '{"model":"claude-haiku-5-5"}' });

    expect(answer.status).toBe(200);
    await expect(answer.json()).resolves.toEqual({ answered: '/v1/messages?beta=true' });
    expect(vendor.asked).toHaveLength(1);
    expect(vendor.asked[0]).toMatchObject({ method: 'POST', path: '/v1/messages?beta=true', body: '{"model":"claude-haiku-5-5"}' });
    expect(vendor.asked[0]?.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(vendor.asked[0]?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(vendor.asked[0]?.headers)).not.toContain(TOKEN);
  });

  it("forwards a running Codex session's request to OpenAI with the key as its bearer token", async () => {
    await aSession({ harness: 'codex', token: TOKEN });

    const answer = await ask('/openai/v1/responses', { token: TOKEN });

    expect(answer.status).toBe(200);
    expect(vendor.asked[0]?.path).toBe('/v1/responses');
    expect(vendor.asked[0]?.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(vendor.asked[0]?.headers['x-api-key']).toBeUndefined();
  });

  it('refuses a token no session holds, forwarding nothing', async () => {
    await aSession({ harness: 'claude-code', token: TOKEN });

    const answer = await ask('/anthropic/v1/messages', { token: 'test-session-token-other' });

    expect(answer.status).toBe(401);
    expect(vendor.asked).toEqual([]);
  });

  it('refuses a request with no token', async () => {
    const answer = await ask('/anthropic/v1/messages');

    expect(answer.status).toBe(401);
    expect(vendor.asked).toEqual([]);
  });

  it('refuses the token of a stopped session (headless S5)', async () => {
    await aSession({ harness: 'claude-code', token: TOKEN, isRunning: false });

    const answer = await ask('/anthropic/v1/messages', { token: TOKEN });

    expect(answer.status).toBe(401);
    expect(vendor.asked).toEqual([]);
  });

  it("refuses a session's token for another harness's vendor", async () => {
    await aSession({ harness: 'codex', token: TOKEN });

    const answer = await ask('/anthropic/v1/messages', { token: TOKEN });

    expect(answer.status).toBe(401);
    expect(vendor.asked).toEqual([]);
  });

  it("refuses a request for any host but the harness's vendor (headless S5)", async () => {
    await aSession({ harness: 'claude-code', token: TOKEN });

    const answer = await ask('/example.com/v1/messages', { token: TOKEN });

    expect(answer.status).toBe(404);
    expect(vendor.asked).toEqual([]);
  });

  it("never sends the key to another host, whatever the path after the vendor's prefix (api keys K7)", async () => {
    await aSession({ harness: 'claude-code', token: TOKEN });
    const attacker = await aVendor();
    const host = attacker.url.replace('http://', '');
    const paths = [
      `/anthropic//${host}/steal`,
      `/anthropic/%2F%2F${host}/steal`,
      `/anthropic/%2f%2f${host}/steal`,
      `/anthropic/@${host}/steal`,
      `/anthropic/v1/..//${host}/steal`,
      `/anthropic/${attacker.url}/steal`,
      `/anthropic/https://${host}/steal`,
      `/anthropic/\\${host}/steal`,
    ];

    for (const path of paths) {
      await ask(path, { token: TOKEN });
    }

    expect(attacker.asked).toEqual([]);
    expect(vendor.asked.every((asked) => asked.headers.host === vendor.url.replace('http://', ''))).toBe(true);
  });

  it('refuses a running session when its harness holds no key, and never moves it elsewhere (api keys, a key removed)', async () => {
    await aSession({ harness: 'codex', token: TOKEN });
    await createKeyFiles(join(home, 'keys')).remove('codex');

    const answer = await ask('/openai/v1/responses', { token: TOKEN });

    expect(answer.status).toBe(401);
    expect(vendor.asked).toEqual([]);
  });

  it('never says a key or a token in a refusal', async () => {
    await aSession({ harness: 'codex', token: TOKEN });

    const answers = await Promise.all([ask('/anthropic/v1/messages', { token: TOKEN }), ask('/openai/v1/responses', { token: 'test-session-token-other' })]);

    for (const answer of answers) {
      const text = await answer.text();
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(OPENAI_KEY);
      expect(text).not.toContain(ANTHROPIC_KEY);
    }
  });

  it("records the key out of credit from the vendor's answer, and passes the answer on as it came (api keys K9)", async () => {
    await aSession({ harness: 'claude-code', token: TOKEN });
    vendorAnswer = { status: 402, body: JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'no credit' } }) };

    const answer = await ask('/anthropic/v1/messages', { token: TOKEN });

    expect(answer.status).toBe(402);
    await expect(answer.json()).resolves.toEqual({ type: 'error', error: { type: 'billing_error', message: 'no credit' } });
    await expect(keyStateOf('claude-code')).resolves.toEqual({ state: 'outOfCredit', at: AT.toISOString() });
    await expect(keyStateOf('codex')).resolves.toEqual({ state: 'ready' });
  });

  it("records the key refused from the vendor's 401", async () => {
    await aSession({ harness: 'codex', token: TOKEN });
    vendorAnswer = { status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }) };

    await ask('/openai/v1/responses', { token: TOKEN });

    await expect(keyStateOf('codex')).resolves.toEqual({ state: 'refused', at: AT.toISOString() });
  });

  it('records the key ready again once the vendor answers it', async () => {
    await aSession({ harness: 'claude-code', token: TOKEN });
    vendorAnswer = { status: 402, body: JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'no credit' } }) };
    await ask('/anthropic/v1/messages', { token: TOKEN });

    vendorAnswer = undefined;
    await ask('/anthropic/v1/messages', { token: TOKEN });

    await expect(keyStateOf('claude-code')).resolves.toEqual({ state: 'ready' });
  });

  it("checks a key out of credit with the smallest request its vendor bills, one output token on its cheapest model, and keeps it out of credit while the vendor says so (api keys K10)", async () => {
    await keys().write('claude-code', ANTHROPIC_KEY);
    await createKeyStates({ keys: join(home, 'keys'), file: keyStatesFile() }).record('claude-code', { state: 'outOfCredit', at: AT });
    vendorAnswer = { status: 402, body: JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'no credit' } }) };

    await proxy.checkOutOfCredit();

    const check = vendor.asked.find((asked) => asked.path === '/v1/messages');
    expect(JSON.parse(check?.body ?? '{}')).toEqual({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] });
    expect(check?.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    await expect(keyStateOf('claude-code')).resolves.toEqual({ state: 'outOfCredit', at: AT.toISOString() });
  });

  it('brings a key out of credit back to ready once the vendor takes the check', async () => {
    await createKeyStates({ keys: join(home, 'keys'), file: keyStatesFile() }).record('codex', { state: 'outOfCredit', at: AT });

    await proxy.checkOutOfCredit();

    const check = vendor.asked.find((asked) => asked.path === '/v1/responses');
    expect(JSON.parse(check?.body ?? '{}')).toEqual({ model: 'gpt-5.5-nano', input: 'Hi', max_output_tokens: 16 });
    expect(check?.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    await expect(keyStateOf('codex')).resolves.toEqual({ state: 'ready' });
  });

  it('checks no key that is ready', async () => {
    await proxy.checkOutOfCredit();

    expect(vendor.asked).toEqual([]);
  });

  it('checks a harness\'s key at once when asked on its own path, and answers its state (login --check)', async () => {
    await createKeyStates({ keys: join(home, 'keys'), file: keyStatesFile() }).record('codex', { state: 'outOfCredit', at: AT });

    const answer = await fetch(`${proxyUrl}/aeolus/check/codex`, { method: 'POST' });

    await expect(answer.json()).resolves.toEqual({ state: 'ready' });
    await expect(keyStateOf('codex')).resolves.toEqual({ state: 'ready' });
  });

  it('answers its version to whoever asks its state, so the trierarch knows it runs', async () => {
    const answer = await fetch(`${proxyUrl}/aeolus/state`);

    expect(answer.status).toBe(200);
    await expect(answer.json()).resolves.toEqual({ version: '0.34.0' });
  });
});
