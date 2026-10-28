import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { checkKey } from './vendor-key-check.js';

/** A made-up key: no test holds a real one. */
const KEY = 'test-key-not-real';

interface Asked {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly headers: IncomingHttpHeaders;
}

let server: Server | undefined;

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

/** A vendor on loopback that answers every request with the status and body given, and keeps what it was asked. */
async function aVendor(status: number, body: unknown): Promise<{ url: string; asked: Asked[] }> {
  const asked: Asked[] = [];
  server = createServer((request, response) => {
    asked.push({ method: request.method, path: request.url, headers: request.headers });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
  const address = listening.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${String(port)}`, asked };
}

describe('the vendor key check', () => {
  it("asks Anthropic for its model list with the key, the one free call (api keys K11)", async () => {
    const vendor = await aVendor(200, { data: [] });

    await expect(checkKey({ harness: 'claude-code', key: KEY, vendorUrl: vendor.url })).resolves.toEqual({ kind: 'taken' });

    expect(vendor.asked).toEqual([expect.objectContaining({ method: 'GET', path: '/v1/models' })]);
    expect(vendor.asked[0]?.headers['x-api-key']).toBe(KEY);
    expect(vendor.asked[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('asks OpenAI for its model list with the key as a bearer token', async () => {
    const vendor = await aVendor(200, { data: [] });

    await expect(checkKey({ harness: 'codex', key: KEY, vendorUrl: vendor.url })).resolves.toEqual({ kind: 'taken' });

    expect(vendor.asked).toEqual([expect.objectContaining({ method: 'GET', path: '/v1/models' })]);
    expect(vendor.asked[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("names the vendor's status and error type when it refuses the key (api keys K9)", async () => {
    const vendor = await aVendor(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });

    await expect(checkKey({ harness: 'claude-code', key: KEY, vendorUrl: vendor.url })).resolves.toEqual({ kind: 'refused', cause: 'Anthropic refused the key: 401 authentication_error' });
  });

  it("never repeats the vendor's message, which may quote part of the key (api keys K7)", async () => {
    const vendor = await aVendor(401, { error: { message: `Incorrect API key provided: ${KEY.slice(0, 8)}***`, type: 'invalid_request_error', code: 'invalid_api_key' } });

    const checked = await checkKey({ harness: 'codex', key: KEY, vendorUrl: vendor.url });

    expect(checked).toEqual({ kind: 'refused', cause: 'OpenAI refused the key: 401 invalid_api_key' });
    expect(JSON.stringify(checked)).not.toContain(KEY.slice(0, 8));
  });

  it('names the status alone when the answer says no error type', async () => {
    const vendor = await aVendor(503, 'unavailable');

    await expect(checkKey({ harness: 'codex', key: KEY, vendorUrl: vendor.url })).resolves.toEqual({ kind: 'refused', cause: 'OpenAI refused the key: 503' });
  });

  it('refuses a key with a character no key holds, such as a line break, without sending it or quoting it (api keys K7)', async () => {
    const vendor = await aVendor(200, { data: [] });
    const broken = 'test-key\nnot-real';

    const checked = await checkKey({ harness: 'claude-code', key: broken, vendorUrl: vendor.url });

    expect(checked).toEqual({ kind: 'refused', cause: 'The key holds a character no API key holds, such as a line break or a space' });
    expect(vendor.asked).toEqual([]);
    expect(JSON.stringify(checked)).not.toContain('test-key');
    expect(JSON.stringify(checked)).not.toContain('not-real');
  });

  it("names how the vendor could not be reached by its error code, never the error's message, which may quote the request", async () => {
    const closed = await aVendor(200, {});
    server?.close();
    server = undefined;

    const checked = await checkKey({ harness: 'codex', key: KEY, vendorUrl: closed.url });

    expect(checked).toEqual({ kind: 'unreachable', cause: `OpenAI could not be reached at ${closed.url} (ECONNREFUSED)` });
  });
});
