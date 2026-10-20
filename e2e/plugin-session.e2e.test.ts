import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MessageId, ShipId } from '@aeolus-fleet/common';
import { createApp, createMigratedDatabase, createPrismaClient, createUseCases, newKey, OPERATOR, operatorCaller, unwrap, type PrismaClient, type ShipCaller, type UseCases } from '@aeolus-fleet/core/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freePort } from './support/free-port.js';

// The aeolus plugin in a real interactive Claude Code session, driven in tmux
// against a fleet on this machine and with no fleet MCP server: the session
// crews a ship with the crew line, answers a message sent while it is idle
// without anyone touching it, and does again after /clear. The watcher hands
// the message over and a hook puts it into the turn, acknowledged first, so
// the model never receives it itself (#756, Q5). Its crew token
// never shows on its screen or in its transcript (#104, #264). It needs a logged-in Claude Code and tmux, so
// it runs only when AEOLUS_PLUGIN_E2E=1, never in CI.

const isEnabled = process.env.AEOLUS_PLUGIN_E2E === '1';
const PLUGIN_DIR = fileURLToPath(new URL('../plugins/aeolus', import.meta.url));
const TMUX_SESSION = 'aeolus-plugin-e2e';
/** A session takes a while to start, think and call the fleet. */
const SESSION_TIMEOUT_MS = 240_000;
const POLL_MS = 1_000;

let database: PrismaClient;
let useCases: UseCases;
let argo: ShipCaller;
let server: FastifyInstance;
let folder: string;
/** Where the session keeps its identity (AEOLUS_CREWS), apart from the crews on this machine. */
let crews: string;
let shipId: ShipId;
let crewLine: string;

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

function pane(): string {
  return tmux('capture-pane', '-t', TMUX_SESSION, '-p');
}

/** Everything the session showed, its scrollback included. */
function wholePane(): string {
  return tmux('capture-pane', '-t', TMUX_SESSION, '-p', '-S', '-');
}

/** The session's transcripts: Claude Code keeps them per project folder, named by its path. */
function transcripts(): string[] {
  const project = join(homedir(), '.claude', 'projects', realpathSync(folder).replace(/[^a-zA-Z0-9]/g, '-'));
  return existsSync(project) ? readdirSync(project).filter((file) => file.endsWith('.jsonl')).map((file) => readFileSync(join(project, file), 'utf8')) : [];
}

/** Types a line into the session and sends it, as the operator would. */
function type(line: string): void {
  tmux('send-keys', '-t', TMUX_SESSION, '-l', line);
  tmux('send-keys', '-t', TMUX_SESSION, 'Enter');
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}. The session shows:\n${pane()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** This test's ship's identity file in the session's crews folder, found by its ship id. */
function identityFile(): string | undefined {
  if (!existsSync(crews)) {
    return undefined;
  }
  const name = readdirSync(crews).find(
    (file) => file.endsWith('.identity') && readFileSync(join(crews, file), 'utf8').includes(`shipId=${shipId}\n`),
  );
  return name === undefined ? undefined : join(crews, name);
}

/** Whether a live watcher holds this ship's lock. */
function isWatching(): boolean {
  const pidFile = identityFile()?.replace(/\.identity$/, '.watch.pid');
  if (pidFile === undefined || !existsSync(pidFile)) {
    return false;
  }
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends argo's message to the ship and waits until the ship acknowledged it,
 * answered it and the turn that took it ended. The model read it from a hook,
 * which put it into the turn (the prompt that starts the turn, a denied first
 * tool call, or a Stop that kept the turn open), and never received it
 * itself: the watcher's push receive is its only claim. The fleet saw every
 * step (decision 0040): received, handed with hand-over number 1,
 * acknowledged and handled.
 */
async function expectAnswered(payload: string, answer: string): Promise<void> {
  const { messageId } = unwrap(
    await useCases.sendMessage(argo, {
      selector: { kind: 'ship', shipId },
      payload,
      idempotencyKey: `e2e-${String(Date.now())}`,
    }),
  );
  await until(async () => {
    const delivery = await database.delivery.findFirstOrThrow({ where: { messageId } });
    return delivery.state === 'acknowledged' || delivery.state === 'handled';
  }, `the ship to acknowledge ${messageId}`);
  const reply = await waitForReply(messageId);
  expect(reply.payload).toContain(answer);
  await until(
    async () => (await database.delivery.findFirstOrThrow({ where: { messageId } })).state === 'handled',
    `the hooks to report ${messageId} handled`,
  );
  const delivery = await database.delivery.findFirstOrThrow({ where: { messageId } });
  expect(delivery.attempts).toBe(1);
  const steps = await database.event.findMany({ where: { deliveryId: delivery.id, type: { startsWith: 'Delivery' } }, orderBy: { seq: 'asc' } });
  expect(steps.map((step) => step.type)).toEqual(['DeliveryReceived', 'DeliveryHanded', 'DeliveryAcknowledged', 'DeliveryHandled']);
  expect(steps[1]?.details).toMatchObject({ handOverNumber: 1 });
  expect(transcripts().some((transcript) => transcript.includes(`: message ${messageId}, text/plain. The plugin acknowledged it for you`))).toBe(true);
}

async function waitForReply(messageId: MessageId) {
  await until(
    async () => (await database.message.count({ where: { inReplyToMessageId: messageId, senderShipId: shipId } })) > 0,
    `the ship to answer ${messageId}`,
  );
  return database.message.findFirstOrThrow({ where: { inReplyToMessageId: messageId, senderShipId: shipId } });
}

describe.skipIf(!isEnabled)('the aeolus plugin in an interactive Claude Code session', () => {
  beforeAll(async () => {
    const databaseUrl = await createMigratedDatabase();
    database = createPrismaClient(databaseUrl);
    const port = await freePort();
    const fleetUrl = `http://127.0.0.1:${String(port)}`;
    useCases = createUseCases({ prisma: database });
    argo = operatorCaller(unwrap(await useCases.initialiseFleet({ name: 'home fleet', ...OPERATOR })));
    server = createApp({ databaseUrl, publicUrl: fleetUrl, logger: false });
    await server.listen({ host: '127.0.0.1', port });
    const commissioned = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'scout', type: 'reviewer' }));
    shipId = commissioned.shipId;
    crewLine = `/aeolus:crew ${fleetUrl} ${shipId} ${commissioned.secret ?? ''}`;

    folder = mkdtempSync(join(tmpdir(), 'aeolus-plugin-e2e-'));
    crews = mkdtempSync(join(tmpdir(), 'aeolus-plugin-e2e-crews-'));
    try {
      tmux('kill-session', '-t', TMUX_SESSION);
    } catch {
      // None left from an earlier run.
    }
  }, SESSION_TIMEOUT_MS);

  afterAll(async () => {
    try {
      tmux('kill-session', '-t', TMUX_SESSION);
    } catch {
      // Already gone.
    }
    rmSync(crews, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
    await server.close();
    await database.$disconnect();
  });

  it('crews the ship with the crew line, and answers a message sent while it is idle, without anyone touching it', async () => {
    // No MCP server at all: the plugin's scripts make every fleet call.
    tmux(
      'new-session', '-d', '-s', TMUX_SESSION, '-x', '200', '-y', '50', '-c', folder, '-e', `AEOLUS_CREWS=${crews}`,
      `claude --plugin-dir '${PLUGIN_DIR}' --mcp-config '{"mcpServers":{}}' --strict-mcp-config --dangerously-skip-permissions`,
    );
    await until(() => {
      const shown = pane();
      if (shown.includes('Yes, I trust this folder')) {
        tmux('send-keys', '-t', TMUX_SESSION, 'Down', 'Enter');
      }
      return shown.includes('bypass permissions on');
    }, 'the session to start');

    type(crewLine);

    await until(() => identityFile() !== undefined, 'the identity file');
    await until(isWatching, 'the watcher to run');
    await expectAnswered('Answer this message with a reply whose payload is exactly: PONG 1', 'PONG 1');
    await until(isWatching, 'the watcher to run again');
    const lease = await database.lease.findFirstOrThrow({ where: { shipId, endedAt: null } });
    expect(lease.pushedAt).not.toBeNull();
    const turns = await database.event.findMany({ where: { shipId, type: 'TurnReported' }, orderBy: { seq: 'asc' } });
    expect(turns.map((reported) => reported.details)).toEqual(expect.arrayContaining([expect.objectContaining({ turn: 'busy' }), expect.objectContaining({ turn: 'idle' })]));
  }, 2 * SESSION_TIMEOUT_MS);

  it('answers again after /clear: the watcher outlives it, and the hook tells the fresh context which ship it crews', async () => {
    type('/clear');
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    await expectAnswered('Answer this message with a reply whose payload is exactly: PONG 2', 'PONG 2');
    await until(isWatching, 'the watcher to run again');
  }, 2 * SESSION_TIMEOUT_MS);

  it('never shows the crew token on its screen or in its transcript', () => {
    const file = identityFile();
    const crewToken = file === undefined ? undefined : /^crewToken=(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1];

    expect(crewToken).toMatch(/^aeolus_ct_v1_/);
    expect(wholePane()).not.toContain(crewToken);
    expect(transcripts()).not.toHaveLength(0);
    for (const transcript of transcripts()) {
      expect(transcript).not.toContain(crewToken);
    }
  });
});
