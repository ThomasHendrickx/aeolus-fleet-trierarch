import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { createCallerCheck } from './caller-check.js';
import { createShipSockets, SHIP_CALL_MAX_BYTES, type ShipSockets } from './ship-sockets.js';

// The socket of each ship the trierarch crews (decision 0026), on a real Unix
// socket in front of a stub fleet over HTTP: what it forwards, what it
// refuses, and what it logs.

const CREW_TOKEN = 'aeolus_ct_v1_of_the_crew';

interface FleetCall {
  method: string;
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

let root: string;
let fleet: Server;
let fleetUrl: string;
let calls: FleetCall[];
let answer: { status: number; body: string };
let tokens: Map<ShipId, string>;
let logged: string[];
/** Whether the caller check lets the caller through. */
let isCallerLet: boolean;
let sockets: ShipSockets;
let shipId: ShipId;

function bodyOf(message: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    message.on('data', (chunk: Buffer) => chunks.push(chunk));
    message.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

beforeEach(async () => {
  // Short, under /tmp: a Unix socket path is at most 104 bytes on macOS.
  root = mkdtempSync('/tmp/aeolus-sockets-');
  calls = [];
  answer = { status: 200, body: '{"ok":true}' };
  fleet = createServer((incoming, response) => {
    void bodyOf(incoming).then((body) => {
      calls.push({ method: incoming.method ?? '', path: incoming.url ?? '', authorization: incoming.headers.authorization, contentType: incoming.headers['content-type'], body });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => fleet.listen(0, '127.0.0.1', resolve));
  const address = fleet.address();
  fleetUrl = typeof address === 'object' && address !== null ? `http://127.0.0.1:${String(address.port)}` : '';
  shipId = newId('ship');
  tokens = new Map([[shipId, CREW_TOKEN]]);
  logged = [];
  isCallerLet = true;
  sockets = createShipSockets({ root, fleetUrl, crewTokenOf: (ship) => Promise.resolve(tokens.get(ship)), mayCall: () => Promise.resolve(isCallerLet), log: (line) => logged.push(line) });
});

afterEach(async () => {
  await sockets.closeAll();
  fleet.closeAllConnections();
  await new Promise<void>((resolve) => fleet.close(() => { resolve(); }));
  rmSync(root, { recursive: true, force: true });
});

/** One call over a socket, as the plugin's curl makes it; none when the socket gives no answer. */
function callOver(socket: string, call: { method: string; path: string; body?: string }): Promise<{ status: number; contentType: string | undefined; body: string } | 'no answer'> {
  return new Promise((resolve) => {
    const outgoing = request({ socketPath: socket, method: call.method, path: call.path, headers: call.body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(call.body)) } }, (incoming) => {
      void bodyOf(incoming).then((body) => {
        resolve({ status: incoming.statusCode ?? 0, contentType: incoming.headers['content-type'], body });
      });
    });
    outgoing.on('error', () => {
      resolve('no answer');
    });
    outgoing.end(call.body ?? '');
  });
}

describe("a ship's socket", () => {
  it("is a Unix socket in a folder of the ship's own, under the root", async () => {
    const socket = await sockets.open(shipId);

    expect(socket).toBe(join(root, shipId, 'fleet.sock'));
    expect(statSync(socket).isSocket()).toBe(true);
    expect(statSync(join(root, shipId)).mode & 0o777).toBe(0o700);
  });

  it('answers the same path when it is opened again, and stays open', async () => {
    const socket = await sockets.open(shipId);

    await expect(sockets.open(shipId)).resolves.toBe(socket);
    await expect(callOver(socket, { method: 'GET', path: '/api/v1/ship/whoami' })).resolves.toMatchObject({ status: 200 });
  });

  it('opens over a socket file a stopped trierarch left behind', async () => {
    const first = createShipSockets({ root, fleetUrl, crewTokenOf: () => Promise.resolve(CREW_TOKEN), mayCall: () => Promise.resolve(true), log: () => undefined });
    await first.open(shipId);
    await first.closeAll();
    const left = await sockets.open(shipId);

    await expect(callOver(left, { method: 'GET', path: '/api/v1/ship/whoami' })).resolves.toMatchObject({ status: 200 });
  });

  it('is gone once closed: a call gets no answer', async () => {
    const socket = await sockets.open(shipId);

    await sockets.close(shipId);

    expect(statSync(socket, { throwIfNoEntry: false })).toBeUndefined();
    await expect(callOver(socket, { method: 'GET', path: '/api/v1/ship/whoami' })).resolves.toBe('no answer');
  });

  it("of a ship crewed fresh is in the sockets folder of its ship's folder, for its owner alone, and its file goes on its close", async () => {
    const shipFolder = join(root, 'ships', shipId);

    const socket = await sockets.open(shipId, shipFolder);
    const isListening = statSync(socket).isSocket();
    await sockets.close(shipId, shipFolder);

    expect([socket, isListening, statSync(join(shipFolder, 'sockets')).mode & 0o777]).toEqual([join(shipFolder, 'sockets', 'fleet.sock'), true, 0o700]);
    expect(statSync(socket, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('of a ship crewed before the ship folders goes with its folder on its close', async () => {
    await sockets.open(shipId);

    await sockets.close(shipId);

    expect(existsSync(join(root, shipId))).toBe(false);
  });

  it('keeps its folder when the trierarch stops, for the socket its session reaches next', async () => {
    const shipFolder = join(root, 'ships', shipId);
    await sockets.open(shipId, shipFolder);
    await sockets.open(newId('ship'));

    await sockets.closeAll();

    expect([existsSync(join(shipFolder, 'sockets')), existsSync(join(shipFolder, 'sockets', 'fleet.sock'))]).toEqual([true, false]);
  });
});

describe('a call over the socket', () => {
  it("goes to the fleet with the ship's crew token as the bearer, its method, path, content type and body unchanged", async () => {
    const socket = await sockets.open(shipId);
    const body = '{"selector":{"kind":"ship","name":"argo"},"payload":"hello","idempotencyKey":"k-1","model":"claude-opus-5-5"}';

    await callOver(socket, { method: 'POST', path: '/api/v1/ship/send', body });

    expect(calls).toEqual([{ method: 'POST', path: '/api/v1/ship/send', authorization: `Bearer ${CREW_TOKEN}`, contentType: 'application/json', body }]);
  });

  it("hands back the fleet's answer unchanged: status, content type and body", async () => {
    answer = { status: 409, body: '{"code":"CONFLICT","message":"This idempotency key was already used"}' };
    const socket = await sockets.open(shipId);

    await expect(callOver(socket, { method: 'POST', path: '/api/v1/ship/send', body: '{}' })).resolves.toEqual({ status: 409, contentType: 'application/json', body: answer.body });
  });

  it('hands back a 503 unchanged, so the plugin waits and calls again as it does with the fleet', async () => {
    answer = { status: 503, body: '{"code":"SERVICE_UNAVAILABLE","message":"The fleet is busy"}' };
    const socket = await sockets.open(shipId);

    await expect(callOver(socket, { method: 'POST', path: '/api/v1/ship/receive', body: '{}' })).resolves.toEqual({ status: 503, contentType: 'application/json', body: answer.body });
  });

  it('takes the crew token at each call, so a new crew token reaches the same socket', async () => {
    const socket = await sockets.open(shipId);
    await callOver(socket, { method: 'GET', path: '/api/v1/ship/whoami' });
    tokens.set(shipId, 'aeolus_ct_v1_of_the_next_crew');

    await callOver(socket, { method: 'GET', path: '/api/v1/ship/whoami' });

    expect(calls.map((call) => call.authorization)).toEqual([`Bearer ${CREW_TOKEN}`, 'Bearer aeolus_ct_v1_of_the_next_crew']);
  });

  it("goes to the fleet API with the ship's crew token as the bearer, its method, path, content type and body unchanged", async () => {
    const socket = await sockets.open(shipId);
    const body = '{"idempotencyKey":"k-2","name":"scout","type":"reviewer"}';

    await callOver(socket, { method: 'POST', path: '/api/v1/fleet/commission', body });

    expect(calls).toEqual([{ method: 'POST', path: '/api/v1/fleet/commission', authorization: `Bearer ${CREW_TOKEN}`, contentType: 'application/json', body }]);
  });

  it("hands back the fleet's 403 for a missing scope unchanged: core decides a fleet call, not the socket", async () => {
    answer = { status: 403, body: '{"code":"FORBIDDEN","message":"This ship lacks the scope fleet:commission"}' };
    const socket = await sockets.open(shipId);

    await expect(callOver(socket, { method: 'POST', path: '/api/v1/fleet/commission', body: '{}' })).resolves.toEqual({ status: 403, contentType: 'application/json', body: answer.body });
  });

  it('lets the session read the ship protocol, which it reads at each start', async () => {
    const socket = await sockets.open(shipId);

    await expect(callOver(socket, { method: 'GET', path: '/api/v1/openapi.json' })).resolves.toMatchObject({ status: 200 });
    expect(calls.map((call) => call.path)).toEqual(['/api/v1/openapi.json']);
  });

  it('gives no answer while the fleet gives none, and nothing is stored', async () => {
    fleet.closeAllConnections();
    await new Promise<void>((resolve) => fleet.close(() => { resolve(); }));
    fleet = createServer();
    const socket = await sockets.open(shipId);

    await expect(callOver(socket, { method: 'POST', path: '/api/v1/ship/send', body: '{}' })).resolves.toBe('no answer');
  });
});

describe('a call the socket refuses, never forwarded', () => {
  it.each([
    { label: 'register', method: 'POST', path: '/api/v1/ship/register' },
    { label: 'deregister', method: 'POST', path: '/api/v1/ship/deregister' },
    { label: 'register under the fleet API', method: 'POST', path: '/api/v1/fleet/register' },
    { label: 'deregister under the fleet API', method: 'POST', path: '/api/v1/fleet/deregister' },
    { label: 'a call outside the ship and fleet APIs', method: 'GET', path: '/api/v1/console/list' },
    { label: 'a path of two words under the fleet API', method: 'POST', path: '/api/v1/fleet/ship/release' },
    { label: 'the tRPC door', method: 'POST', path: '/trpc/ship.send' },
    { label: 'the tRPC door for a fleet call', method: 'POST', path: '/trpc/fleet.commission' },
    { label: 'a path that climbs out of the ship API', method: 'GET', path: '/api/v1/ship/../../trpc/ship.send' },
    { label: 'a path that climbs out of the fleet API', method: 'POST', path: '/api/v1/fleet/../ship/register' },
  ])('refuses $label with 403', async ({ method, path }) => {
    const socket = await sockets.open(shipId);

    const refused = await callOver(socket, { method, path, body: '{}' });

    expect(refused).toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
  });

  it('forwards a send of a 256 KB payload, the most the fleet takes, with the JSON around it', async () => {
    const socket = await sockets.open(shipId);
    const body = JSON.stringify({ selector: { kind: 'ship', name: 'argo' }, payload: 'a'.repeat(262_144), idempotencyKey: 'k'.repeat(256), model: 'claude-opus-5-5', inReplyTo: 'msg_01m679bfr46y1vgk4cxx918e2d' });

    await expect(callOver(socket, { method: 'POST', path: '/api/v1/ship/send', body })).resolves.toMatchObject({ status: 200 });
  });

  it(`forwards a body of ${String(SHIP_CALL_MAX_BYTES)} bytes, the most it takes`, async () => {
    const socket = await sockets.open(shipId);

    await expect(callOver(socket, { method: 'POST', path: '/api/v1/ship/send', body: 'x'.repeat(SHIP_CALL_MAX_BYTES) })).resolves.toMatchObject({ status: 200 });
  });

  it(`forwards a fleet call of ${String(SHIP_CALL_MAX_BYTES)} bytes, and refuses one byte over with 413`, async () => {
    const socket = await sockets.open(shipId);

    await expect(callOver(socket, { method: 'POST', path: '/api/v1/fleet/commission', body: 'x'.repeat(SHIP_CALL_MAX_BYTES) })).resolves.toMatchObject({ status: 200 });
    await expect(callOver(socket, { method: 'POST', path: '/api/v1/fleet/commission', body: 'x'.repeat(SHIP_CALL_MAX_BYTES + 1) })).resolves.toMatchObject({ status: 413 });
    expect(calls).toHaveLength(1);
  });

  it('refuses a body one byte over with 413', async () => {
    const socket = await sockets.open(shipId);

    await expect(callOver(socket, { method: 'POST', path: '/api/v1/ship/send', body: 'x'.repeat(SHIP_CALL_MAX_BYTES + 1) })).resolves.toMatchObject({ status: 413 });
    expect(calls).toEqual([]);
  });
});

describe("a caller outside the ship's session (the caller check)", () => {
  it('is refused with 403, never forwarded, and the call is logged', async () => {
    isCallerLet = false;
    const socket = await sockets.open(shipId);

    await expect(callOver(socket, { method: 'POST', path: '/api/v1/ship/send', body: '{}' })).resolves.toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
    expect(logged).toEqual([`${shipId} POST /api/v1/ship/send 403`]);
  });

  it('is refused a fleet call with 403 too, never forwarded', async () => {
    isCallerLet = false;
    const socket = await sockets.open(shipId);

    await expect(callOver(socket, { method: 'POST', path: '/api/v1/fleet/commission', body: '{}' })).resolves.toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')("gets 403 when it is a process outside the ship's session and the trierarch, with nothing forwarded", async () => {
    const checked = createShipSockets({ root, fleetUrl, crewTokenOf: () => Promise.resolve(CREW_TOKEN), mayCall: createCallerCheck({ platform: process.platform, sessionRootOf: () => Promise.resolve(undefined) }), log: () => undefined });
    const socket = await checked.open(newId('ship'));
    const answered = join(root, 'answered');
    // Started by a shell that ends at once, so curl has another parent than this process.
    spawn('sh', ['-c', 'curl -s -o /dev/null -w "%{http_code}" --unix-socket "$0" http://trierarch/api/v1/ship/whoami > "$1.tmp" && mv "$1.tmp" "$1" &', socket, answered], { stdio: 'ignore' }).unref();

    await expect.poll(() => (existsSync(answered) ? readFileSync(answered, 'utf8') : ''), { timeout: 5000 }).toBe('403');
    expect(calls).toEqual([]);
    await checked.closeAll();
  });
});

describe("the socket's log", () => {
  it('writes one line per call: the ship, the method, the path and the status, never the body or the crew token', async () => {
    const socket = await sockets.open(shipId);

    await callOver(socket, { method: 'POST', path: '/api/v1/ship/send', body: '{"payload":"a secret plan"}' });
    await callOver(socket, { method: 'POST', path: '/api/v1/ship/register', body: '{}' });

    expect(logged).toEqual([`${shipId} POST /api/v1/ship/send 200`, `${shipId} POST /api/v1/ship/register 403`]);
    expect(logged.join('\n')).not.toMatch(/secret plan|aeolus_ct_v1/);
  });
});
