import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { MessageId, ShipId } from '@aeolus-fleet/common';
import { createApp, createMigratedDatabase, createPrismaClient, createUseCases, newKey, OPERATOR, operatorCaller, unwrap, type PrismaClient, type ShipCaller, type UseCases } from '@aeolus-fleet/core/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freePort } from './support/free-port.js';

// The aeolus-fleet plugin in a real interactive GitHub Copilot CLI session
// (1.0.105), driven in tmux against a fleet on this machine: a folder crewed by
// hand, as a person registers it with the plugin's script, and a session that
// answers a message sent while it is idle, without anyone touching it. The
// session starts the watcher as a detached background shell; the watcher
// hands the message over and exits, its completion starts a turn, and the
// hooks acknowledge the message before they put it into that turn (design
// harnesses/cursor-copilot, CC12). Its crew token never shows in its pane or
// its transcript. It installs this folder's plugin into a Copilot home of its
// own, with the signed-in Copilot's config.json, so the machine's Copilot is
// left as it was. It needs a signed-in Copilot and tmux, so it runs only when
// AEOLUS_PLUGIN_COPILOT_E2E=1, never in CI.

const isEnabled = process.env.AEOLUS_PLUGIN_COPILOT_E2E === '1';
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(REPOSITORY, 'plugins', 'aeolus-fleet', 'scripts');
const SIGNED_IN_COPILOT_HOME = process.env.COPILOT_HOME ?? join(homedir(), '.copilot');
const TMUX_SESSION = 'aeolus-plugin-copilot-e2e';
/** A session takes a while to start, think and call the fleet. */
const SESSION_TIMEOUT_MS = 240_000;
const POLL_MS = 1_000;
const TYPING_SETTLE_MS = 1_000;

let database: PrismaClient;
let useCases: UseCases;
let argo: ShipCaller;
let server: FastifyInstance;
let folder: string;
let copilotHome: string;
/** Where the session keeps its identity (AEOLUS_CREWS), apart from the crews on this machine. */
let crews: string;
let shipId: ShipId;

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

async function type(line: string): Promise<void> {
  tmux('send-keys', '-t', TMUX_SESSION, '-l', line);
  await new Promise((resolve) => setTimeout(resolve, TYPING_SETTLE_MS));
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

function copilot(...args: string[]): string {
  return execFileSync('copilot', args, { encoding: 'utf8', env: { ...process.env, COPILOT_HOME: copilotHome } });
}

/** This test's ship's identity file in the session's crews folder, found by its ship id. */
function identityFile(): string | undefined {
  if (!existsSync(crews)) {
    return undefined;
  }
  const name = readdirSync(crews).find((file) => file.endsWith('.identity') && readFileSync(join(crews, file), 'utf8').includes(`shipId=${shipId}\n`));
  return name === undefined ? undefined : join(crews, name);
}

/** A file beside this test's ship's identity file, its content, or nothing when there is none. */
function sibling(suffix: string): string | undefined {
  const file = identityFile()?.replace(/\.identity$/, suffix);
  return file !== undefined && existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

/** The session's transcripts: Copilot keeps them under its home's session-state folder. */
function transcripts(): string[] {
  const sessions = join(copilotHome, 'session-state');
  if (!existsSync(sessions)) {
    return [];
  }
  return readdirSync(sessions, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => readFileSync(join(sessions, file), 'utf8'));
}

async function waitForReply(messageId: MessageId) {
  await until(
    async () => (await database.message.count({ where: { inReplyToMessageId: messageId, senderShipId: shipId } })) > 0,
    `the ship to answer ${messageId}`,
  );
  return database.message.findFirstOrThrow({ where: { inReplyToMessageId: messageId, senderShipId: shipId } });
}

describe.skipIf(!isEnabled)('the aeolus-fleet plugin in an interactive Copilot session crewed by hand', () => {
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

    folder = realpathSync(mkdtempSync(join(tmpdir(), 'aeolus-plugin-copilot-e2e-')));
    execFileSync('git', ['init', '-q'], { cwd: folder });
    copilotHome = mkdtempSync(join(tmpdir(), 'aeolus-copilot-home-'));
    copyFileSync(join(SIGNED_IN_COPILOT_HOME, 'config.json'), join(copilotHome, 'config.json'));
    crews = join(copilotHome, 'aeolus-crews');
    copilot('plugin', 'marketplace', 'add', REPOSITORY);
    copilot('plugin', 'install', 'aeolus-fleet@aeolus-fleet');
    // Crewed by hand, as a person registers the folder with the plugin's script; run
    // without blocking, so the fleet in this process answers it.
    const registered = await promisify(execFile)('bash', [join(SCRIPTS, 'aeolus-fleet.sh'), 'register', fleetUrl, shipId, commissioned.secret ?? '', 'DEVICE'], {
      cwd: folder,
      env: {
        ...process.env,
        AEOLUS_HARNESS: 'copilot',
        AEOLUS_CREWS: crews,
        AEOLUS_FOLDER: folder,
        AEOLUS_DATA: join(copilotHome, 'plugin-data', 'aeolus-fleet', 'aeolus-fleet'),
      },
    });
    expect(registered.stdout).toContain('aeolus: this folder now crews scout');
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
    rmSync(copilotHome, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
    await server.close();
    await database.$disconnect();
  });

  it('starts the watcher as a detached background shell, and answers a message sent while it is idle, without anyone touching it', async () => {
    tmux(
      'new-session', '-d', '-s', TMUX_SESSION, '-x', '200', '-y', '50', '-c', folder, '-e', `COPILOT_HOME=${copilotHome}`, '-e', `AEOLUS_CREWS=${crews}`,
      // A session of the machine's own harness exports its folder's variables (AEOLUS_FOLDER and the like): the
      // Copilot session gets none of them, as in a terminal of its own.
      ['env', ...Object.keys(process.env).filter((name) => /^(AEOLUS_|CLAUDE)/.test(name)).flatMap((name) => ['-u', name]), 'copilot', '--allow-all-tools', '--allow-all-paths'].join(' '),
    );
    await until(() => pane().includes('Do you trust the files in this folder?'), 'the folder trust question');
    tmux('send-keys', '-t', TMUX_SESSION, 'Enter');
    await until(() => pane().includes('? help'), 'the session to start');

    await type('Go on as the Aeolus Fleet start context says.');
    await until(() => sibling('.watch.pid') !== undefined && sibling('.turn')?.startsWith('idle ') === true, 'the turn to end, with the watcher running');

    const { messageId } = unwrap(
      await useCases.sendMessage(argo, {
        selector: { kind: 'ship', shipId },
        payload: 'Answer this message with a reply whose payload is exactly: PONG 1',
        idempotencyKey: `e2e-${String(Date.now())}`,
      }),
    );
    const reply = await waitForReply(messageId);
    expect(reply.payload).toContain('PONG 1');
    await until(
      async () => (await database.delivery.findFirstOrThrow({ where: { messageId } })).state === 'handled',
      `the hooks to report ${messageId} handled`,
    );
    const delivery = await database.delivery.findFirstOrThrow({ where: { messageId } });
    expect(delivery.attempts).toBe(1);
    const steps = await database.event.findMany({ where: { deliveryId: delivery.id, type: { startsWith: 'Delivery' } }, orderBy: { seq: 'asc' } });
    expect(steps.map((step) => step.type)).toEqual(['DeliveryReceived', 'DeliveryHanded', 'DeliveryAcknowledged', 'DeliveryHandled']);
    const lease = await database.lease.findFirstOrThrow({ where: { shipId, endedAt: null } });
    expect(lease.pushedAt).not.toBeNull();
    expect(transcripts().some((transcript) => transcript.includes(`: message ${messageId}, text/plain. The plugin acknowledged it for you`))).toBe(true);
    // The hook recorded the model Copilot's session names, and the script stated it.
    expect(reply.model).toBe(sibling('.model')?.trim());
  }, 3 * SESSION_TIMEOUT_MS);

  it('never shows the crew token in its pane or its transcript', () => {
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
