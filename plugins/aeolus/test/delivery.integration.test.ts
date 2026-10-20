import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ShipId } from '@aeolus-fleet/common';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp, createMigratedDatabase, createPrismaClient, createUseCases, FLEET_URL, newKey, OPERATOR, operatorCaller, secretOf, unwrap, type ShipCaller, type PrismaClient, type UseCases } from '@aeolus-fleet/core/testing';

import { scriptEnvironment } from './script-environment.js';

// The aeolus plugin's scripts against a real fleet (#819): the watcher and the
// hooks of a pushed ship, run as a session runs them, reach the real core
// through a door that can lose the fleet's answer to a call after the fleet
// stored it. Whatever answer is lost, the model sees every message the fleet
// holds acknowledged for the session.

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const ACK = '/api/v1/ship/ack';
const PAYLOAD = 'Review PR 12 and say what you found';
const HANDED_OVER = 'aeolus: a message for scout is handed to this session: it reaches you at your next tool call, or when you end your turn. Do not receive or ack it.\n';

/** A call and every retry the plugin makes of it while the fleet is busy (AEOLUS_BUSY_WAITS, four by default). */
const BUSY_ANSWERS = 5;

interface Run {
  status: number | null;
  stdout: string;
}

/**
 * The fleet's REST door with a fault in it: each call goes on to the real
 * fleet, and the answer to the next call on a path set to lose comes back to
 * no one, though the fleet stored it. A call on a path set busy never
 * reaches the fleet, its retries neither: the door answers as a busy fleet does.
 */
interface LossyDoor {
  url: string;
  /** The next call on this path reaches the fleet; its answer is lost. */
  loseNextAnswerTo(path: string): void;
  /** The next call on this path reaches the fleet, and its answer is held until the door closes; settles once the fleet answered. */
  holdNextAnswerTo(path: string): Promise<void>;
  /** The next call on this path, and each time it is made again, is answered busy, 503 SERVICE_UNAVAILABLE: nothing stored. */
  busyNext(path: string): void;
  close(): Promise<void>;
}

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function startLossyDoor(fleetUrl: string): Promise<LossyDoor> {
  const losing = new Set<string>();
  const holding = new Map<string, () => void>();
  const busy = new Map<string, number>();
  const server: Server = createServer((request, response) => {
    void bodyOf(request).then(async (body) => {
      const path = request.url ?? '';
      const busyFor = busy.get(path) ?? 0;
      if (busyFor > 0) {
        busy.set(path, busyFor - 1);
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: 'The fleet is busy: nothing was stored. Make the same call again.' }));
        return;
      }
      const method = request.method ?? 'GET';
      const headers: Record<string, string> = {};
      if (request.headers.authorization !== undefined) headers.authorization = request.headers.authorization;
      if (body !== '') headers['content-type'] = 'application/json';
      const answer = await fetch(`${fleetUrl}${path}`, { method, headers, ...(body === '' ? {} : { body }) });
      const text = await answer.text();
      const held = holding.get(path);
      if (held !== undefined) {
        holding.delete(path);
        held();
        return;
      }
      if (losing.delete(path)) {
        request.socket.destroy();
        return;
      }
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('The lossy door listens on no TCP port');
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    loseNextAnswerTo: (path) => {
      losing.add(path);
    },
    holdNextAnswerTo: (path) =>
      new Promise((resolve) => {
        holding.set(path, resolve);
      }),
    busyNext: (path) => {
      busy.set(path, BUSY_ANSWERS);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

let database: PrismaClient;
let useCases: UseCases;
let argo: ShipCaller;
let fleet: FastifyInstance;
let door: LossyDoor;
let shipId: ShipId;
let secret: string;
let fleetUrl: string;
let data: string;
let folder: string;
let home: string;

beforeEach(async () => {
  const databaseUrl = await createMigratedDatabase();
  database = createPrismaClient(databaseUrl);
  useCases = createUseCases({ prisma: database });
  argo = operatorCaller(unwrap(await useCases.initialiseFleet({ name: 'home fleet', ...OPERATOR })));
  const scout = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'scout', type: 'reviewer' }));
  shipId = scout.shipId;
  secret = secretOf(scout.secret);
  fleet = createApp({ databaseUrl, publicUrl: FLEET_URL, logger: false, receiveWaitMs: 100 });
  fleetUrl = await fleet.listen({ host: '127.0.0.1', port: 0 });
  door = await startLossyDoor(fleetUrl);
  data = mkdtempSync(join(tmpdir(), 'aeolus-data-'));
  home = mkdtempSync(join(tmpdir(), 'aeolus-home-'));
  folder = mkdtempSync(join(tmpdir(), 'aeolus-folder-'));
});

afterEach(async () => {
  await door.close();
  await fleet.close();
  await database.$disconnect();
  rmSync(data, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

/** Runs a script in its own process group, so a test can kill it with all it started, as a session dies. */
function start(script: string, options: { args?: string[]; env?: Record<string, string>; stdin?: string } = {}) {
  const child = spawn('bash', [join(SCRIPTS, script), ...(options.args ?? [])], {
    detached: true,
    env: scriptEnvironment({ HOME: home, AEOLUS_HARNESS: 'claude-code', AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_RETRY_SECONDS: '0', ...options.env }),
  });
  child.stdin.end(options.stdin ?? '');
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  const done = new Promise<Run>((resolve) => {
    child.on('close', (status) => {
      resolve({ status, stdout });
    });
  });
  const kill = () => {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  };
  return { done, kill };
}

/** A hook as Claude Code runs it: the payload on stdin, the plugin's variables and the project folder set, no AEOLUS_ ones. */
function aHook(script: string, payload: Record<string, unknown>) {
  return start(script, {
    stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, ...payload }),
    env: { AEOLUS_HARNESS: '', AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: folder, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin', AEOLUS_BUSY_WAITS: '0 0 0 0' },
  });
}

const aFirstToolCall = () => aHook('aeolus-handover.sh', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });
const aTurnEnds = () => aHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: true }).done;
const aSessionStart = () => aHook('aeolus-session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' }).done;
const aPrompt = () => aHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: 'hello again' }).done;
/** The watcher, bounded so a test that hands nothing over ends. */
const theWatcher = () => start('aeolus-wait.sh', { env: { AEOLUS_WAIT_SECONDS: '1', AEOLUS_MAX_SECONDS: '6' } }).done;

/** The session crews scout through the lossy door, ends its turn, and argo sends it a message; the watcher hands it over. */
async function aMessageHandedOver(): Promise<void> {
  const registered = await start('aeolus-fleet.sh', { args: ['register', door.url, shipId, secret, 'DEVICE'] }).done;
  expect(registered.status, registered.stdout).toBe(0);
  await aTurnEnds();
  unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', shipId }, payload: PAYLOAD, idempotencyKey: newKey() }));
  await expect(theWatcher()).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
}

const theDelivery = () => database.delivery.findFirstOrThrow({ where: { recipientShipId: shipId } });

describe('the plugin on a real fleet: a message the fleet holds acknowledged reaches the model (#819)', () => {
  it('puts a message into the turn when the answer to its ack was lost: the watcher hands it over again, and the next tool call confirms it', async () => {
    await aMessageHandedOver();
    door.loseNextAnswerTo(ACK);
    expect((await aFirstToolCall().done).stdout).toBe('');
    expect((await theDelivery()).state).toBe('acknowledged');
    await aTurnEnds();

    await expect(theWatcher()).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
    expect((await aFirstToolCall().done).stdout).toContain(PAYLOAD);
  });

  it('puts a message into the first prompt when the session was killed after the fleet stored its ack, before the plugin heard the answer', async () => {
    await aMessageHandedOver();
    const acknowledging = door.holdNextAnswerTo(ACK);
    const toolCall = aFirstToolCall();
    await acknowledging;
    toolCall.kill();
    await toolCall.done;
    expect((await theDelivery()).state).toBe('acknowledged');

    await aSessionStart();

    expect((await aPrompt()).stdout).toContain(PAYLOAD);
  });
});

const SECOND_PAYLOAD = 'Then merge PR 13 once it is green';
const aTurnFails = () => aHook('aeolus-turn-died.sh', { hook_event_name: 'StopFailure', error: 'rate_limit' }).done;

/** What the folder's store holds: one line per entry. */
const store = async () => (await start('aeolus-identity.sh', { args: ['store'] }).done).stdout;

/** Another ship of the fleet, crewed: its id and the lease its crew holds. */
async function aCrewedLookout(): Promise<{ shipId: ShipId; leaseId: string }> {
  const lookout = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'lookout', type: 'reviewer' }));
  const registered = await fetch(`${fleetUrl}/api/v1/ship/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shipId: lookout.shipId, secret: secretOf(lookout.secret), location: { kind: 'DEVICE' }, harness: 'claude-code' }),
  });
  expect(registered.status).toBe(200);
  const lease = await database.lease.findFirstOrThrow({ where: { shipId: lookout.shipId, endedAt: null } });
  return { shipId: lookout.shipId, leaseId: lease.id };
}

/** Puts the first message's delivery in a state the fleet refuses the plugin's next call on, as another door or the operator would. */
async function theFleetMoves(data: { state?: 'handed' | 'acknowledged' | 'undeliverable'; claimedByShipId?: string; claimedByLeaseId?: string; handedOnceMoreAt?: Date }): Promise<string> {
  const delivery = await theDelivery();
  await database.delivery.update({ where: { id: delivery.id }, data });
  return delivery.id;
}

/** A second message, sent after the refused one, reaches the model: the refused delivery blocks nothing. */
async function expectTheNextMessageReachesTheModel(): Promise<void> {
  unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', shipId }, payload: SECOND_PAYLOAD, idempotencyKey: newKey() }));
  await aTurnEnds();
  await expect(theWatcher()).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
  expect((await aFirstToolCall().done).stdout).toContain(SECOND_PAYLOAD);
}

describe('the plugin on a real fleet: a delivery the fleet refuses is dropped, and blocks no other (#832)', () => {
  /** The first message was handed over and its ack answered busy: the watcher hands it over again at the next idle. */
  async function aMessageToHandOverAgain(): Promise<void> {
    await aMessageHandedOver();
    door.busyNext(ACK);
    expect((await aFirstToolCall().done).stdout).toBe('');
  }

  it('drops a message whose hand-over the fleet refuses as held by another ship', async () => {
    await aMessageToHandOverAgain();
    const lookout = await aCrewedLookout();
    const refused = await theFleetMoves({ claimedByShipId: lookout.shipId, claimedByLeaseId: lookout.leaseId });

    await expectTheNextMessageReachesTheModel();
    expect(await store()).not.toContain(refused);
  });

  it('drops a message whose hand-over the fleet refuses as not in flight', async () => {
    await aMessageToHandOverAgain();
    const refused = await theFleetMoves({ state: 'acknowledged' });

    await expectTheNextMessageReachesTheModel();
    expect(await store()).not.toContain(refused);
  });

  it('drops a message whose ack the fleet refuses as not in flight', async () => {
    await aMessageHandedOver();
    const refused = await theFleetMoves({ state: 'undeliverable' });
    expect((await aFirstToolCall().done).stdout).toBe('');

    await expectTheNextMessageReachesTheModel();
    expect(await store()).not.toContain(refused);
  });

  it('drops a message whose ack the fleet refuses as held by another ship', async () => {
    await aMessageHandedOver();
    const lookout = await aCrewedLookout();
    const refused = await theFleetMoves({ claimedByShipId: lookout.shipId, claimedByLeaseId: lookout.leaseId });
    expect((await aFirstToolCall().done).stdout).toBe('');

    await expectTheNextMessageReachesTheModel();
    expect(await store()).not.toContain(refused);
  });

  it('drops a message the fleet refuses to hand once more as not acknowledged', async () => {
    await aMessageHandedOver();
    expect((await aFirstToolCall().done).stdout).toContain(PAYLOAD);
    await aTurnFails();
    const refused = await theFleetMoves({ state: 'handed' });

    expect((await aPrompt()).stdout).toBe('');
    expect(await store()).not.toContain(refused);
  });

  it('drops a message the fleet refuses to hand once more as handed once more already', async () => {
    await aMessageHandedOver();
    expect((await aFirstToolCall().done).stdout).toContain(PAYLOAD);
    await aTurnFails();
    const refused = await theFleetMoves({ handedOnceMoreAt: new Date() });

    expect((await aPrompt()).stdout).toBe('');
    expect(await store()).not.toContain(refused);
  });

  it('drops a message whose handled the fleet refuses as held by another ship', async () => {
    await aMessageHandedOver();
    expect((await aFirstToolCall().done).stdout).toContain(PAYLOAD);
    const lookout = await aCrewedLookout();
    const refused = await theFleetMoves({ claimedByShipId: lookout.shipId, claimedByLeaseId: lookout.leaseId });

    await expectTheNextMessageReachesTheModel();
    expect(await store()).not.toContain(refused);
  });
});
