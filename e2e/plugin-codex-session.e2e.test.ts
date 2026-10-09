import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MessageId, ShipId } from '@aeolus-fleet/common';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient, type PrismaClient } from '../packages/core/src/adapters/prisma/client.js';
import { createApp } from '../packages/core/src/app.js';
import type { Caller } from '../packages/core/src/domain/shared/caller.js';
import { createUseCases, systemClock, type UseCases } from '../packages/core/src/wiring.js';
import { OPERATOR, operatorCaller } from '../packages/core/test/support/core-fixtures.js';
import { createMigratedDatabase } from '../packages/core/test/support/database.js';
import { unwrap } from '../packages/core/test/support/result.js';
import { freePort } from './support/web.js';
import { newKey } from '../packages/core/test/support/keys.js';

// The aeolus plugin in a real interactive Codex session, driven in tmux
// against a fleet on this machine and with no fleet MCP server: the session
// crews a ship with the Codex crew line and answers a message when woken,
// and its crew token never shows in its pane or its transcript (#104, #264).
// It installs this folder's plugin into a Codex home of its own, with the
// signed-in Codex's auth.json, so the machine's Codex is left as it was. It
// needs a signed-in Codex and tmux, so it runs only when
// AEOLUS_PLUGIN_CODEX_E2E=1, never in CI. Codex runs outside its sandbox, as
// a trierarch runs it; AEOLUS_PLUGIN_CODEX_E2E_SANDBOX=1 runs it in the
// workspace-write sandbox with the README's one-time setup instead, on a
// machine where that sandbox works.

const isEnabled = process.env.AEOLUS_PLUGIN_CODEX_E2E === '1';
const isSandboxed = process.env.AEOLUS_PLUGIN_CODEX_E2E_SANDBOX === '1';
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const SIGNED_IN_CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const TMUX_SESSION = 'aeolus-plugin-codex-e2e';
/** A session takes a while to start, think and call the fleet. */
const SESSION_TIMEOUT_MS = 240_000;
const POLL_MS = 1_000;
/** Codex takes an Enter right after fast typing as part of a paste: wait before it, as the trierarch does. */
const TYPING_SETTLE_MS = 1_000;

let database: PrismaClient;
let useCases: UseCases;
let argo: Caller;
let server: FastifyInstance;
let folder: string;
let codexHome: string;
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

/** Types a line into the session and sends it, as the operator would. */
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

function codex(...args: string[]): string {
  return execFileSync('codex', args, { encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome } });
}

/** This test's ship's identity file in the Codex plugin's data folder, found by its ship id. */
function identityFile(): string | undefined {
  const ships = join(codexHome, 'plugins', 'data', 'aeolus-aeolus-fleet', 'ships');
  if (!existsSync(ships)) {
    return undefined;
  }
  const name = readdirSync(ships).find(
    (file) => file.endsWith('.identity') && readFileSync(join(ships, file), 'utf8').includes(`shipId=${shipId}\n`),
  );
  return name === undefined ? undefined : join(ships, name);
}

/** The session's transcripts: Codex keeps them under its home's sessions folder. */
function transcripts(): string[] {
  const sessions = join(codexHome, 'sessions');
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

describe.skipIf(!isEnabled)('the aeolus plugin in an interactive Codex session', () => {
  beforeAll(async () => {
    const databaseUrl = await createMigratedDatabase();
    database = createPrismaClient(databaseUrl);
    const port = await freePort();
    const fleetUrl = `http://127.0.0.1:${String(port)}`;
    useCases = createUseCases({ prisma: database, clock: systemClock });
    argo = operatorCaller(unwrap(await useCases.initialiseFleet({ name: 'home fleet', ...OPERATOR })));
    server = createApp({ databaseUrl, publicUrl: fleetUrl, logger: false });
    await server.listen({ host: '127.0.0.1', port });
    const commissioned = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'scout', type: 'reviewer' }));
    shipId = commissioned.shipId;
    crewLine = `$aeolus-crew ${fleetUrl} ${shipId} ${commissioned.secret ?? ''}`;

    folder = realpathSync(mkdtempSync(join(tmpdir(), 'aeolus-plugin-codex-e2e-')));
    execFileSync('git', ['init', '-q'], { cwd: folder });
    codexHome = mkdtempSync(join(tmpdir(), 'aeolus-codex-home-'));
    copyFileSync(join(SIGNED_IN_CODEX_HOME, 'auth.json'), join(codexHome, 'auth.json'));
    const data = join(codexHome, 'plugins', 'data', 'aeolus-aeolus-fleet');
    writeFileSync(
      join(codexHome, 'config.toml'),
      [
        `[projects.${JSON.stringify(folder)}]`,
        'trust_level = "trusted"',
        ...(isSandboxed ? ['[sandbox_workspace_write]', 'network_access = true', `writable_roots = [${JSON.stringify(data)}]`] : []),
        '',
      ].join('\n'),
    );
    codex('plugin', 'marketplace', 'add', REPOSITORY);
    codex('plugin', 'add', 'aeolus@aeolus-fleet');
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
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
    await server.close();
    await database.$disconnect();
  });

  it('crews the ship with the Codex crew line and answers a message when woken', async () => {
    const flags = isSandboxed ? ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'] : ['--dangerously-bypass-approvals-and-sandbox'];
    tmux(
      'new-session', '-d', '-s', TMUX_SESSION, '-x', '200', '-y', '50', '-c', folder, '-e', `CODEX_HOME=${codexHome}`,
      ['codex', ...flags, '--dangerously-bypass-hook-trust', '--no-daemon'].join(' '),
    );
    await until(() => pane().includes('Aeolus') || pane().includes('›'), 'the session to start');

    await type(crewLine);
    await until(() => identityFile() !== undefined, 'the identity file');

    const { messageId } = unwrap(
      await useCases.sendMessage(argo, {
        selector: { kind: 'ship', shipId },
        payload: 'Answer this message with a reply whose payload is exactly: PONG 1',
        idempotencyKey: `e2e-${String(Date.now())}`,
      }),
    );
    await type('$aeolus-wake ');
    const reply = await waitForReply(messageId);
    expect(reply.payload).toContain('PONG 1');
    // The hook recorded the active model, and the script stated it.
    const modelFile = identityFile()?.replace(/\.identity$/, '.model');
    expect(modelFile !== undefined && existsSync(modelFile)).toBe(true);
    expect(reply.model).toBe(modelFile === undefined ? undefined : readFileSync(modelFile, 'utf8').trim());
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
