import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startStubFleet, type StubAnswer, type StubFleet } from './stub-fleet.js';

// aeolus-fleet.sh, the one door of a session's fleet calls: it registers with
// the crew line's secret and keeps the crew token in the folder's identity
// file, and every later call reads the token there, so the model never sees it.

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const CREW_TOKEN = 'aeolus_ct_v1_kept_out_of_sight';
const NEW_CREW_TOKEN = 'aeolus_ct_v1_of_the_new_crew';
const SECRET = 'aeolus_sk_v1_from_the_crew_line';
const SHIP_ID = 'shp_01m3tbfspe96yf1rnr4ank9h1a';
const DELIVERY_ID = 'dlv_01m3tbfspe96yf1rnr4ank9h1b';

let data: string;
let folder: string;
let fleet: StubFleet | undefined;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'aeolus-data-'));
  folder = mkdtempSync(join(tmpdir(), 'aeolus-folder-'));
});

afterEach(async () => {
  await fleet?.close();
  fleet = undefined;
  rmSync(data, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a script as a session's command does, without blocking the stub fleet in this process. */
function run(script: string, options: { args?: string[]; env?: Record<string, string>; stdin?: string } = {}): Promise<Run> {
  const child = spawn('bash', [join(SCRIPTS, script), ...(options.args ?? [])], {
    env: { ...process.env, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, ...options.env },
  });
  child.stdin.end(options.stdin ?? '');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return new Promise((resolve) => {
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

async function crewedAt(answers: readonly StubAnswer[], squadron?: string): Promise<StubFleet> {
  const started = await startStubFleet(answers);
  const args = ['write', started.url, SHIP_ID, 'scout', CREW_TOKEN, ...(squadron === undefined ? [] : [squadron])];
  expect((await run('aeolus-identity.sh', { args })).status).toBe(0);
  return started;
}

async function identityFile(): Promise<string> {
  return (await run('aeolus-identity.sh', { args: ['path'] })).stdout.trim();
}

const registered = { status: 200, body: { crewToken: CREW_TOKEN } };
/** The fleet's refusal while every pool connection is taken: nothing was stored (#542). */
const busy = { status: 503, body: { code: 'SERVICE_UNAVAILABLE', message: 'The fleet is busy; nothing was stored. Make the same call again (for send, with the same idempotency key).' } };
const whoami = { status: 200, body: { shipId: SHIP_ID, fleetId: 'flt_01m3tbfspe96yf1rnr4ank9h1c', name: 'scout', type: 'implementer' } };

function expectNoToken(result: Run): void {
  expect(result.stdout).not.toContain(CREW_TOKEN);
  expect(result.stderr).not.toContain(CREW_TOKEN);
}

describe('aeolus-fleet register', () => {
  it('registers with the secret, the location and the harness claude-code, and keeps the crew token in the identity file', async () => {
    fleet = await startStubFleet([registered, whoami]);

    const result = await run('aeolus-fleet.sh', { args: ['register', `${fleet.url}/`, SHIP_ID, SECRET, 'SERVER'] });

    expect(result.status).toBe(0);
    expect(fleet.calls[0]).toEqual({
      method: 'POST',
      path: '/api/v1/ship/register',
      authorization: undefined,
      body: JSON.stringify({ shipId: SHIP_ID, secret: SECRET, location: { kind: 'SERVER' }, harness: 'claude-code' }),
    });
    expect(fleet.calls[1]).toMatchObject({ method: 'GET', path: '/api/v1/ship/whoami', authorization: `Bearer ${CREW_TOKEN}` });
    const identity = readFileSync(await identityFile(), 'utf8');
    expect(identity).toContain(`fleetUrl=${fleet.url}\n`);
    expect(identity).toContain(`shipId=${SHIP_ID}\nshipName=scout\ncrewToken=${CREW_TOKEN}\n`);
    expect(statSync(await identityFile()).mode & 0o777).toBe(0o600);
  });

  it('says which ship the folder now crews, and never shows the crew token or the secret', async () => {
    fleet = await startStubFleet([registered, whoami]);

    const result = await run('aeolus-fleet.sh', { args: ['register', fleet.url, SHIP_ID, SECRET, 'DEVICE'] });

    expect(result.stdout).toContain(`this folder now crews scout (${SHIP_ID})`);
    expectNoToken(result);
    expect(result.stdout).not.toContain(SECRET);
  });

  it('states a location of another kind with its words', async () => {
    fleet = await startStubFleet([registered, whoami]);

    await run('aeolus-fleet.sh', { args: ['register', fleet.url, SHIP_ID, SECRET, 'OTHER:a "lab" box'] });

    expect(JSON.parse(fleet.calls[0]?.body ?? '')).toMatchObject({ location: { kind: 'OTHER', description: 'a "lab" box' } });
  });

  it('states the harness AEOLUS_HARNESS names, as a Codex session sets it', async () => {
    fleet = await startStubFleet([registered, whoami]);

    await run('aeolus-fleet.sh', { args: ['register', fleet.url, SHIP_ID, SECRET, 'DEVICE'], env: { AEOLUS_HARNESS: 'codex' } });

    expect(JSON.parse(fleet.calls[0]?.body ?? '')).toMatchObject({ harness: 'codex' });
  });

  it("keeps a squadron member's squadron", async () => {
    fleet = await startStubFleet([registered, whoami]);

    await run('aeolus-fleet.sh', { args: ['register', fleet.url, SHIP_ID, SECRET, 'DEVICE', 'team-one'] });

    expect(readFileSync(await identityFile(), 'utf8')).toContain('squadron=team-one\n');
  });

  it('refuses a location that is not DEVICE, CLOUD, SERVER or OTHER with words, calling nothing', async () => {
    fleet = await startStubFleet([registered, whoami]);

    const result = await run('aeolus-fleet.sh', { args: ['register', fleet.url, SHIP_ID, SECRET, 'LAPTOP'] });

    expect(result.status).toBe(2);
    expect(fleet.calls).toEqual([]);
  });

  it('refuses while the folder already crews a ship, calling nothing', async () => {
    fleet = await crewedAt([registered, whoami]);

    const result = await run('aeolus-fleet.sh', { args: ['register', fleet.url, SHIP_ID, SECRET, 'DEVICE'] });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain('this folder already crews scout');
    expect(fleet.calls).toEqual([]);
  });

  it("says what the fleet refused, such as a ship another session crews, and keeps no identity", async () => {
    fleet = await startStubFleet([{ status: 409, body: { code: 'CONFLICT', message: 'This ship is crewed' } }]);

    const result = await run('aeolus-fleet.sh', { args: ['register', fleet.url, SHIP_ID, SECRET, 'DEVICE'] });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('CONFLICT: This ship is crewed');
    expect(statSync(await identityFile(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('keeps the crew token even when whoami then fails, named by the ship id, so the lease is not lost', async () => {
    fleet = await startStubFleet([registered, { status: 500, body: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed' } }]);

    const result = await run('aeolus-fleet.sh', { args: ['register', fleet.url, SHIP_ID, SECRET, 'DEVICE'] });

    expect(result.status).toBe(0);
    expect(readFileSync(await identityFile(), 'utf8')).toContain(`shipName=${SHIP_ID}\ncrewToken=${CREW_TOKEN}\n`);
  });
});

describe('aeolus-fleet calls', () => {
  it('receives with the crew token from the identity file and prints what the fleet answers', async () => {
    const answer = { deliveries: [{ deliveryId: DELIVERY_ID, payload: 'hello' }] };
    fleet = await crewedAt([{ status: 200, body: answer }]);

    const result = await run('aeolus-fleet.sh', { args: ['receive', '{"max":10}'] });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(answer);
    expect(fleet.calls).toEqual([{ method: 'POST', path: '/api/v1/ship/receive', authorization: `Bearer ${CREW_TOKEN}`, body: '{"max":10}' }]);
    expectNoToken(result);
  });

  it('receives one delivery when given no input', async () => {
    fleet = await crewedAt([{ status: 200, body: { deliveries: [] } }]);

    await run('aeolus-fleet.sh', { args: ['receive'] });

    expect(fleet.calls[0]?.body).toBe('{}');
  });

  it('acks and pongs a delivery by its id', async () => {
    fleet = await crewedAt([{ status: 200, body: {} }]);

    await run('aeolus-fleet.sh', { args: ['ack', DELIVERY_ID] });
    await run('aeolus-fleet.sh', { args: ['pong', DELIVERY_ID] });

    expect(fleet.calls.map((call) => [call.path, call.body])).toEqual([
      ['/api/v1/ship/ack', `{"deliveryId":"${DELIVERY_ID}"}`],
      ['/api/v1/ship/pong', `{"deliveryId":"${DELIVERY_ID}"}`],
    ]);
  });

  it("sends the input it reads from stdin with -, so a payload's quotes and newlines need no shell quoting", async () => {
    fleet = await crewedAt([{ status: 200, body: { messageId: 'msg_01m3tbfspe96yf1rnr4ank9h1d' } }]);
    const input = JSON.stringify({ selector: { kind: 'ship', name: 'orchestrator-1' }, payload: "It's \"done\"\nPR 12", idempotencyKey: 'send-1', model: 'claude-opus-5-5' });

    const result = await run('aeolus-fleet.sh', { args: ['send', '-'], stdin: input });

    expect(result.status).toBe(0);
    expect(fleet.calls[0]).toMatchObject({ path: '/api/v1/ship/send', body: input });
  });

  it('states the model a hook recorded on every send, over one the input states, as the Codex hook records it', async () => {
    fleet = await crewedAt([{ status: 200, body: { messageId: 'msg_01m3tbfspe96yf1rnr4ank9h1d' } }]);
    writeFileSync((await identityFile()).replace(/\.identity$/, '.model'), 'gpt-6-astra\n');

    await run('aeolus-fleet.sh', { args: ['send', '-'], stdin: '{"payload":"a \\"model\\": in the text","model":"stale"}\n' });
    await run('aeolus-fleet.sh', { args: ['send', '{ }'] });

    expect(fleet.calls.map((call): unknown => JSON.parse(call.body))).toEqual([
      { payload: 'a "model": in the text', model: 'gpt-6-astra' },
      { model: 'gpt-6-astra' },
    ]);
  });

  it('reports, checks the inbox and deregisters as POST, and asks whoami and the report log as GET', async () => {
    fleet = await crewedAt([{ status: 200, body: {} }]);

    await run('aeolus-fleet.sh', { args: ['report', '{"state":"idle"}'] });
    await run('aeolus-fleet.sh', { args: ['inbox'] });
    await run('aeolus-fleet.sh', { args: ['whoami'] });
    await run('aeolus-fleet.sh', { args: ['reportLog'] });
    await run('aeolus-fleet.sh', { args: ['deregister'] });

    expect(fleet.calls.map((call) => `${call.method} ${call.path} ${call.body}`)).toEqual([
      'POST /api/v1/ship/report {"state":"idle"}',
      'POST /api/v1/ship/inbox {}',
      'GET /api/v1/ship/whoami ',
      'GET /api/v1/ship/reportLog ',
      'POST /api/v1/ship/deregister ',
    ]);
    expect(fleet.calls.every((call) => call.authorization === `Bearer ${CREW_TOKEN}`)).toBe(true);
  });

  it('says LEASE_ENDED, and exits 3, when the operator released the ship', async () => {
    fleet = await crewedAt([{ status: 401, body: { code: 'LEASE_ENDED', message: 'This ship was released' } }]);

    const result = await run('aeolus-fleet.sh', { args: ['receive'] });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('LEASE_ENDED');
    expectNoToken(result);
  });

  it('forgets the ship on LEASE_ENDED with the crew token the identity file still holds', async () => {
    fleet = await crewedAt([{ status: 401, body: { code: 'LEASE_ENDED', message: 'This ship was released' } }]);

    const result = await run('aeolus-fleet.sh', { args: ['receive'] });

    expect(result.stdout).toContain('the plugin forgot it');
    expect(statSync(await identityFile(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('keeps the identity file, and calls again with its crew token, when the folder was crewed again during the call', async () => {
    let answerLeaseEnded = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      answerLeaseEnded = resolve;
    });
    fleet = await crewedAt([
      { status: 401, body: { code: 'LEASE_ENDED', message: 'This ship was released' }, hold: held },
      { status: 200, body: { deliveries: [] } },
    ]);
    const stub = fleet;
    const call = run('aeolus-fleet.sh', { args: ['receive'] });
    await expect.poll(() => stub.calls.length).toBe(1);
    expect((await run('aeolus-identity.sh', { args: ['write', stub.url, SHIP_ID, 'scout', NEW_CREW_TOKEN] })).status).toBe(0);
    answerLeaseEnded();

    const result = await call;

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"deliveries":[]}\n');
    expect(stub.calls[1]).toMatchObject({ path: '/api/v1/ship/receive', authorization: `Bearer ${NEW_CREW_TOKEN}` });
    expect(readFileSync(await identityFile(), 'utf8')).toContain(`crewToken=${NEW_CREW_TOKEN}\n`);
    expect(result.stdout).not.toContain(NEW_CREW_TOKEN);
  });

  it("says what the fleet refused, and exits 1, for any other refusal", async () => {
    fleet = await crewedAt([{ status: 400, body: { code: 'BAD_REQUEST', message: 'model: Required' } }]);

    const result = await run('aeolus-fleet.sh', { args: ['send', '{}'] });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('BAD_REQUEST: model: Required');
  });

  it('makes the same call again by itself while the fleet is busy, so a send keeps its idempotency key', async () => {
    fleet = await crewedAt([busy, busy, { status: 200, body: { messageId: 'msg_01m3tbfspe96yf1rnr4ank9h1d' } }]);
    const input = JSON.stringify({ selector: { kind: 'ship', name: 'orchestrator-1' }, payload: 'done', idempotencyKey: 'send-1', model: 'claude-opus-5-5' });

    const result = await run('aeolus-fleet.sh', { args: ['send', '-'], stdin: input, env: { AEOLUS_BUSY_WAITS: '0.01 0.01 0.01 0.01' } });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ messageId: 'msg_01m3tbfspe96yf1rnr4ank9h1d' });
    expect(fleet.calls.map((call) => [call.path, call.body])).toEqual([
      ['/api/v1/ship/send', input],
      ['/api/v1/ship/send', input],
      ['/api/v1/ship/send', input],
    ]);
  });

  it('waits longer before each next call while the fleet stays busy', async () => {
    fleet = await crewedAt([busy, busy, { status: 200, body: {} }]);
    const stub = fleet;
    const calledAt: number[] = [];
    const watching = setInterval(() => {
      if (calledAt.length < stub.calls.length) {
        calledAt.push(Date.now());
      }
    }, 5);

    await run('aeolus-fleet.sh', { args: ['whoami'], env: { AEOLUS_BUSY_WAITS: '0.2 0.6' } });
    clearInterval(watching);

    const [first = 0, second = 0, third = 0] = calledAt;
    expect(second - first).toBeGreaterThanOrEqual(150);
    expect(third - second).toBeGreaterThanOrEqual(550);
  });

  it('says the fleet is busy, and exits 1, once every wait is spent, calling once more than it waits', async () => {
    fleet = await crewedAt([busy]);

    const result = await run('aeolus-fleet.sh', { args: ['receive'], env: { AEOLUS_BUSY_WAITS: '0.01 0.01 0.01' } });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('SERVICE_UNAVAILABLE: The fleet is busy');
    expect(fleet.calls).toHaveLength(4);
  });

  it('waits 1, 2, 4 and 8 seconds while the fleet stays busy, unless AEOLUS_BUSY_WAITS says otherwise', () => {
    expect(readFileSync(join(SCRIPTS, 'aeolus-fleet.sh'), 'utf8')).toContain('BUSY_WAITS="${AEOLUS_BUSY_WAITS:-1 2 4 8}"');
  });

  it('calls once, without waiting, on any other refusal', async () => {
    fleet = await crewedAt([{ status: 500, body: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed' } }]);

    await run('aeolus-fleet.sh', { args: ['whoami'], env: { AEOLUS_BUSY_WAITS: '0.01' } });

    expect(fleet.calls).toHaveLength(1);
  });

  it('says the fleet did not answer, and exits 6, when it cannot be reached', async () => {
    fleet = await crewedAt([]);
    const unreachable = fleet.url;
    await fleet.close();
    fleet = undefined;

    const result = await run('aeolus-fleet.sh', { args: ['whoami'] });

    expect(result.status).toBe(6);
    expect(result.stdout).toContain(`no answer from ${unreachable}`);
    expectNoToken(result);
  });

  it('says the folder crews no ship, and exits 2, calling nothing', async () => {
    const result = await run('aeolus-fleet.sh', { args: ['receive'] });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('this folder crews no ship');
  });

  it('refuses a call it does not know, calling nothing', async () => {
    fleet = await crewedAt([{ status: 200, body: {} }]);

    const result = await run('aeolus-fleet.sh', { args: ['commission'] });

    expect(result.status).toBe(2);
    expect(fleet.calls).toEqual([]);
  });
});

describe('aeolus-fleet protocol', () => {
  it("prints the ship protocol from the fleet's OpenAPI description, with no crew token", async () => {
    const description = 'Aeolus carries messages between ships.\n\n1. Call "register" once.\n2. Loop: receive.';
    fleet = await crewedAt([{ status: 200, body: { openapi: '3.1.1', info: { title: 'Aeolus ship API', version: '1', description }, paths: { '/ship/send': { post: { description: 'Sends.' } } } } }]);

    const result = await run('aeolus-fleet.sh', { args: ['protocol'] });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${description}\n`);
    expect(fleet.calls).toEqual([{ method: 'GET', path: '/api/v1/openapi.json', authorization: undefined, body: '' }]);
  });
});

describe('aeolus-identity show', () => {
  it('names the identity file without pointing at the crew token in it', async () => {
    fleet = await crewedAt([]);

    const shown = await run('aeolus-identity.sh', { args: ['show'] });

    expect(shown.stdout).not.toContain('crewToken');
    expect(shown.stdout).not.toContain('crew token');
  });
});
