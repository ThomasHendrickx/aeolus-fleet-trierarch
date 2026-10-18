import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QUESTION_CONTENT_TYPE,
  REPLACEMENT_CONTENT_TYPE,
  WITHDRAWAL_CONTENT_TYPE,
  questionSchema,
  replacementSchema,
  withdrawalSchema,
} from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { startRoutedStubFleet, type StubAnswer, type StubFleet } from './stub-fleet.js';
import { scriptEnvironment } from './script-environment.js';

// aeolus-ask.sh: a crewed session asks its ship's owner a question (decisions
// 0038, 0045), and withdraws or replaces it, without writing its JSON by hand.
// It sends through aeolus-fleet.sh, so the crew token stays out of sight.

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const CREW_TOKEN = 'aeolus_ct_v1_kept_out_of_sight';
const SHIP_ID = 'shp_01m3tbfspe96yf1rnr4ank9h1a';
const MESSAGE_ID = 'msg_01m3tbfspe96yf1rnr4ank9h1c';
const QUESTION_ID = '3f1c2a9e-7b4d-4e8a-9c1f-2d6b8e0a5c47';
const OWNER_ID = 'shp_01m3tbfspe96yf1rnr4ank9h1d';
const sent = { status: 200, body: { messageId: MESSAGE_ID } };
const WHOAMI_PATH = '/api/v1/ship/whoami';
const SEND_PATH = '/api/v1/ship/send';
/** whoami of a ship a person owns. */
const ownedByThomas = { status: 200, body: { shipId: SHIP_ID, fleetId: 'flt_01m3tbfspe96yf1rnr4ank9h1e', name: 'scout', type: 'reviewer', ownerShipId: OWNER_ID, ownerName: 'thomas' } };

let data: string;
let folder: string;
/** A throwaway home: the identities live under it, never in the real one. */
let home: string;
let fleet: StubFleet | undefined;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'aeolus-data-'));
  home = mkdtempSync(join(tmpdir(), 'aeolus-home-'));
  folder = mkdtempSync(join(tmpdir(), 'aeolus-folder-'));
});

afterEach(async () => {
  await fleet?.close();
  fleet = undefined;
  rmSync(data, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a script as a session's command does, without blocking the stub fleet in this process. */
function run(script: string, args: string[]): Promise<Run> {
  return runWith(script, { args });
}

/** Runs a script as `run` does, with its input on stdin. */
function runWith(script: string, { args, stdin = '' }: { args: string[]; stdin?: string }): Promise<Run> {
  const child = spawn('bash', [join(SCRIPTS, script), ...args], {
    env: scriptEnvironment({ HOME: home, AEOLUS_FOLDER: folder, AEOLUS_DATA: data }),
  });
  child.stdin.end(stdin);
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

/** Runs a hook with its payload on stdin; a hook calls no fleet, so it may block. */
function hook(script: string, payload: unknown): void {
  spawnSync('bash', [join(SCRIPTS, script)], { input: JSON.stringify(payload), env: scriptEnvironment({ HOME: home, AEOLUS_FOLDER: folder, AEOLUS_DATA: data }) });
}

/** A crewed folder whose fleet answers whoami as the ship's owner says, and each send as the answers say. */
async function crewedAt(answers: readonly StubAnswer[], whoami: StubAnswer = ownedByThomas): Promise<StubFleet> {
  const started = await startRoutedStubFleet({ [WHOAMI_PATH]: [whoami, whoami], [SEND_PATH]: answers });
  expect((await runWith('aeolus-identity.sh', { args: ['write', started.url, SHIP_ID, 'scout'], stdin: CREW_TOKEN })).status).toBe(0);
  return started;
}

const sendSchema = z.object({
  selector: z.union([z.strictObject({ kind: z.literal('ship'), shipId: z.string() }), z.strictObject({ kind: z.literal('ship'), name: z.string() })]),
  contentType: z.string(),
  payload: z.string().transform((text): unknown => JSON.parse(text)),
  idempotencyKey: z.string().min(1),
  model: z.string(),
});

/** The sends the stub fleet received, their payloads read as JSON. */
function sendsOf(stub: StubFleet) {
  return stub.calls.filter(({ path }) => path === SEND_PATH).map(({ body }) => sendSchema.parse(JSON.parse(body)));
}

/** The one send the stub fleet received, after whoami named the owner. */
function theSend(stub: StubFleet) {
  expect(stub.calls.map(({ path }) => path)).toEqual([WHOAMI_PATH, SEND_PATH]);
  return sendSchema.parse(JSON.parse(stub.calls[1]?.body ?? ''));
}

const aQuestion = [
  '--title', 'Which port does the console use in development?',
  '--context', 'docs/architecture.md says 3000 and the README says 4000.',
  '--option', 'Keep 3000', 'What the console uses now.',
  '--option', 'Move to 4000', 'Frees 3000 for core.',
  '--pick', '2', 'Fewest changes.',
  '--model', 'claude-opus-5-5',
];

describe('aeolus-ask.sh ask', () => {
  it("sends the ship's owner, as whoami names it, the question as the question content type, with a uuid of its own and the options numbered from 1, and says its uuid and message", async () => {
    fleet = await crewedAt([sent]);

    const result = await run('aeolus-ask.sh', ['ask', ...aQuestion]);

    expect(result.status).toBe(0);
    const send = theSend(fleet);
    expect(send).toMatchObject({ selector: { kind: 'ship', shipId: OWNER_ID }, contentType: QUESTION_CONTENT_TYPE, model: 'claude-opus-5-5' });
    const question = questionSchema.parse(send.payload);
    expect(question).toEqual({
      id: question.id,
      title: 'Which port does the console use in development?',
      context: 'docs/architecture.md says 3000 and the README says 4000.',
      options: [
        { key: 1, label: 'Keep 3000', detail: 'What the console uses now.' },
        { key: 2, label: 'Move to 4000', detail: 'Frees 3000 for core.' },
      ],
      pick: { option: 2, why: 'Fewest changes.' },
    });
    expect(result.stdout).toContain(question.id);
    expect(result.stdout).toContain(MESSAGE_ID);
    expect(fleet.calls[1]?.authorization).toBe(`Bearer ${CREW_TOKEN}`);
    expect(result.stdout + result.stderr).not.toContain(CREW_TOKEN);
  });

  it('gives every question a uuid and an idempotency key of its own', async () => {
    fleet = await crewedAt([sent, sent]);

    await run('aeolus-ask.sh', ['ask', ...aQuestion]);
    await run('aeolus-ask.sh', ['ask', ...aQuestion]);

    const sends = sendsOf(fleet);
    const ids = sends.map(({ payload }) => questionSchema.parse(payload).id);
    expect(new Set(ids).size).toBe(2);
    expect(new Set(sends.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(2);
  });

  it('carries quotes, backslashes, newlines and tabs in its text as they are', async () => {
    fleet = await crewedAt([sent]);
    const context = 'It says "3000"\nand C:\\console\tthere.';

    await run('aeolus-ask.sh', ['ask', '--title', 'Port?', '--context', context, '--option', 'Keep', '', '--pick', '1', 'It "works".', '--model', 'm']);

    expect(questionSchema.parse(theSend(fleet).payload)).toMatchObject({ context, options: [{ key: 1, label: 'Keep', detail: '' }], pick: { why: 'It "works".' } });
  });

  it.each([
    ['no title', ['--context', 'c', '--option', 'A', 'a', '--pick', '1', 'why']],
    ['no option', ['--title', 't', '--context', 'c', '--pick', '1', 'why']],
    ['an option without a label', ['--title', 't', '--option', '', 'a', '--pick', '1', 'why']],
    ['a pick that names no option', ['--title', 't', '--option', 'A', 'a', '--pick', '2', 'why']],
    ['a pick without why', ['--title', 't', '--option', 'A', 'a', '--pick', '1', '']],
    ['no pick', ['--title', 't', '--option', 'A', 'a']],
    ['an unknown flag', ['--title', 't', '--option', 'A', 'a', '--pick', '1', 'why', '--colour', 'red']],
  ])('refuses a question with %s, and sends nothing', async (_what, args) => {
    fleet = await crewedAt([sent]);

    const result = await run('aeolus-ask.sh', ['ask', ...args]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
    expect(fleet.calls).toEqual([]);
  });

  it('states the model the Codex hook records on the aeolus-ask.sh call itself, so a model switch shows on the question', async () => {
    fleet = await crewedAt([sent]);
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: "scripts/aeolus-ask.sh ask --title 'Port?'" }, model: 'gpt-5.5' };

    hook('aeolus-model.sh', payload);
    await run('aeolus-ask.sh', ['ask', '--title', 'Port?', '--option', 'Keep', '', '--pick', '1', 'Fewest changes.']);

    expect(theSend(fleet).model).toBe('gpt-5.5');
  });

  it("asks argo by name when the ship has no owner, as argo's own ship has none", async () => {
    fleet = await crewedAt([sent], { status: 200, body: { ...ownedByThomas.body, ownerShipId: null, ownerName: null } });

    await run('aeolus-ask.sh', ['ask', ...aQuestion]);

    expect(theSend(fleet).selector).toEqual({ kind: 'ship', name: 'argo' });
  });

  it("says the fleet's refusal of whoami with its exit code, and sends nothing, as it cannot know the owner", async () => {
    fleet = await crewedAt([sent], { status: 503, body: { code: 'UNAVAILABLE', message: 'try again' } });

    const result = await run('aeolus-ask.sh', ['ask', ...aQuestion]);

    expect(result.status).toBe(1);
    expect(sendsOf(fleet)).toEqual([]);
  });

  it("says the fleet's refusal as aeolus-fleet.sh does, with its exit code", async () => {
    fleet = await crewedAt([{ status: 400, body: { code: 'VALIDATION', message: 'model is required' } }]);

    const result = await run('aeolus-ask.sh', ['ask', ...aQuestion]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('VALIDATION');
  });
});

describe('aeolus-ask.sh withdraw', () => {
  it("sends the ship's owner a withdrawal naming the question", async () => {
    fleet = await crewedAt([sent]);

    const result = await run('aeolus-ask.sh', ['withdraw', QUESTION_ID, '--model', 'claude-opus-5-5']);

    expect(result.status).toBe(0);
    const send = theSend(fleet);
    expect(send).toMatchObject({ selector: { kind: 'ship', shipId: OWNER_ID }, contentType: WITHDRAWAL_CONTENT_TYPE });
    expect(withdrawalSchema.parse(send.payload)).toEqual({ questionId: QUESTION_ID });
  });

  it('refuses a question id that is not a uuid, and sends nothing', async () => {
    fleet = await crewedAt([sent]);

    const result = await run('aeolus-ask.sh', ['withdraw', 'msg_01m3tbfspe96yf1rnr4ank9h1c']);

    expect(result.status).toBe(2);
    expect(fleet.calls).toEqual([]);
  });
});

describe('aeolus-ask.sh replace', () => {
  it("sends the ship's owner a replacement naming the question, with the new question under a uuid of its own", async () => {
    fleet = await crewedAt([sent]);

    const result = await run('aeolus-ask.sh', ['replace', QUESTION_ID, ...aQuestion]);

    expect(result.status).toBe(0);
    const send = theSend(fleet);
    expect(send).toMatchObject({ selector: { kind: 'ship', shipId: OWNER_ID }, contentType: REPLACEMENT_CONTENT_TYPE });
    const replacement = replacementSchema.parse(send.payload);
    expect(replacement).toMatchObject({ questionId: QUESTION_ID, question: { title: 'Which port does the console use in development?', pick: { option: 2 } } });
    expect(result.stdout).toContain(replacement.question.id);
  });

  it('refuses a replacement whose new question is incomplete, and sends nothing', async () => {
    fleet = await crewedAt([sent]);

    const result = await run('aeolus-ask.sh', ['replace', QUESTION_ID, '--title', 't']);

    expect(result.status).toBe(2);
    expect(fleet.calls).toEqual([]);
  });
});
