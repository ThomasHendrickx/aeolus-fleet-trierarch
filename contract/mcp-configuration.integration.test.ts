import { spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { idSchema, questionSchema, type ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newKey, unwrap, type ShipCaller } from '@aeolus-fleet/core/testing';

import { aCrewingMachine, listedEntryOf, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, runProgram, PLUGIN_ROOT, type Machine } from './support/machine.js';
import { isTodaysTrierarch } from './support/trierarch-under-test.js';

// The fleet's MCP configuration from the trierarch plugin's ship: asked for, applied, confirmed and offered (docs/trierarch.md, "Crew-time MCP servers").

const CONFIGURATION_TYPE = 'application/vnd.aeolus.trierarch.mcp-configuration+json';
const REQUEST_TYPE = 'application/vnd.aeolus.trierarch.mcp-configuration-request+json';
const APPLIED_TYPE = 'application/vnd.aeolus.trierarch.mcp-configuration-applied+json';

/** A pass runs every 5 seconds. */
const ANSWERED_WITHIN_MS = 30_000;

/** A server that needs no credential, so the configuration carries no sealed secret. */
const GRAPH = { name: 'company-graph', url: 'https://graph.example.test/mcp', transport: 'streamable-http', tools: ['read_neo4j_cypher'] };

let fleet: Fleet;
let machine: Machine;
let plugin: ShipId;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
  plugin = await fleet.commission('trierarch-plugin');
  await aCrewingMachine({ fleet, machine, pluginShip: plugin });
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

const reportSchema = z.object({ sealingKey: z.object({ publicKey: z.string() }), harnesses: z.array(z.object({ harness: z.string(), mcpServers: z.array(z.string()).optional() })) });

/** The key the trierarch reports, which a configuration is sealed to. */
async function reportedKey(): Promise<string> {
  await expect.poll(async () => reportSchema.safeParse((await fleet.reportOfTrierarch())?.details).success, { timeout: ANSWERED_WITHIN_MS }).toBe(true);
  return reportSchema.parse((await fleet.reportOfTrierarch())?.details).sealingKey.publicKey;
}

/** The MCP servers the trierarch reports Claude Code offers. */
async function offeredByClaudeCode(): Promise<readonly string[]> {
  const report = reportSchema.safeParse((await fleet.reportOfTrierarch())?.details);
  return report.success ? (report.data.harnesses.find(({ harness }) => harness === 'claude-code')?.mcpServers ?? []) : [];
}

/** The payloads the trierarch sent the plugin ship, of the content type, oldest first. */
async function sentToPlugin(contentType: string): Promise<readonly unknown[]> {
  const messages = await fleet.database.message.findMany({ where: { senderShipId: fleet.trierarchShip.shipId, selectorShipId: plugin, contentType }, orderBy: { createdAt: 'asc' }, select: { payload: true } });
  return messages.map(({ payload }) => z.unknown().parse(JSON.parse(payload ?? 'null')));
}

function aConfiguration(at: { version: number; publicKey: string; fleetId?: string; servers?: readonly unknown[] }): { payload: string; contentType: string } {
  return { payload: JSON.stringify({ fleetId: at.fleetId ?? fleet.argo.fleetId, pluginShipId: plugin, version: at.version, publicKey: at.publicKey, servers: at.servers ?? [GRAPH], secrets: [] }), contentType: CONFIGURATION_TYPE };
}

describe.skipIf(isTodaysTrierarch)("the fleet's MCP configuration", () => {
  it("asks the trierarch plugin's ship for it, naming its fleet and that ship", async () => {
    await expect.poll(() => sentToPlugin(REQUEST_TYPE), { timeout: ANSWERED_WITHIN_MS }).toContainEqual({ fleetId: fleet.argo.fleetId, pluginShipId: plugin });
  });

  it('applies a configuration of its fleet sealed to its key, confirms it and offers its servers', async () => {
    const publicKey = await reportedKey();

    await fleet.sendToTrierarchAs(plugin, aConfiguration({ version: 1, publicKey }));

    await expect.poll(() => sentToPlugin(APPLIED_TYPE), { timeout: ANSWERED_WITHIN_MS }).toContainEqual({ fleetId: fleet.argo.fleetId, pluginShipId: plugin, version: 1, publicKey });
    await expect.poll(offeredByClaudeCode, { timeout: ANSWERED_WITHIN_MS }).toEqual(['company-graph']);
  });

  it('offers no server once an empty configuration of a later version is applied', async () => {
    const publicKey = await reportedKey();
    await fleet.sendToTrierarchAs(plugin, aConfiguration({ version: 1, publicKey }));
    await expect.poll(offeredByClaudeCode, { timeout: ANSWERED_WITHIN_MS }).toEqual(['company-graph']);

    await fleet.sendToTrierarchAs(plugin, aConfiguration({ version: 2, publicKey, servers: [] }));

    await expect.poll(offeredByClaudeCode, { timeout: ANSWERED_WITHIN_MS }).toEqual([]);
  });

  it('takes nothing of a configuration of another fleet and confirms none', async () => {
    const publicKey = await reportedKey();

    const messageId = await fleet.sendToTrierarchAs(plugin, aConfiguration({ version: 1, publicKey, fleetId: 'flt_01m3tb1zgr5h2ffee12xnch8sw' }));

    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: ANSWERED_WITHIN_MS }).toBe('acknowledged');
    expect(await sentToPlugin(APPLIED_TYPE)).toEqual([]);
    expect(await offeredByClaudeCode()).toEqual([]);
  });

  it('takes nothing of a configuration from another ship', async () => {
    const publicKey = await reportedKey();
    const stranger = await fleet.commission('stranger');

    const messageId = await fleet.sendToTrierarchAs(stranger, aConfiguration({ version: 1, publicKey }));

    await expect.poll(() => fleet.deliveryStateOf(messageId), { timeout: ANSWERED_WITHIN_MS }).toBe('acknowledged');
    expect(await sentToPlugin(APPLIED_TYPE)).toEqual([]);
  });

  it('confirms the version it persisted again after a restart', async () => {
    const publicKey = await reportedKey();
    await fleet.sendToTrierarchAs(plugin, aConfiguration({ version: 1, publicKey }));
    await expect.poll(async () => (await sentToPlugin(APPLIED_TYPE)).length, { timeout: ANSWERED_WITHIN_MS }).toBe(1);

    const restarted = await machine.trierarch(['restart']);
    expect(restarted.status, restarted.stdout + restarted.stderr).toBe(0);

    await expect.poll(async () => (await sentToPlugin(APPLIED_TYPE)).length, { timeout: ANSWERED_WITHIN_MS }).toBe(2);
    await expect.poll(offeredByClaudeCode, { timeout: ANSWERED_WITHIN_MS }).toEqual(['company-graph']);
  });
});

// Permission calls share the MCP proxy, but never use a fleet MCP server.
describe.skipIf(isTodaysTrierarch)('permission questions for the owner', () => {
  it.each(['connection closes', 'ship is released'])('puts the question in the owner inbox and withdraws it when the %s', async (end) => {
    const owner = await fleet.commission('thomas');
    await fleet.database.ship.update({ where: { id: owner }, data: { kind: 'person' } });
    const scout = await fleet.commission('scout', { owner });
    const config = join(machine.trierarchHome, 'config.json');
    const configuration = z.looseObject({ harnesses: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(config, 'utf8')));
    writeFileSync(config, JSON.stringify({ ...configuration, harnesses: { ...configuration.harnesses, 'claude-code': { flags: [], options: {} } } }));
    expect((await machine.trierarch(['restart'])).status).toBe(0);
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code', options: { model: 'claude-opus-5' } });
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: ANSWERED_WITHIN_MS }).toBe('running');
    const servers = z.object({ mcpServers: z.record(z.string(), z.object({ url: z.string(), headers: z.record(z.string(), z.string()) })) }).parse(JSON.parse(readFileSync(join(machine.trierarchHome, 'sessions', scout, 'mcp-config.json'), 'utf8')));
    const permission = servers.mcpServers['aeolus-permissions'];
    expect(permission).toBeDefined();
    if (permission === undefined) throw new Error('permission server is missing');
    const cancellation = new AbortController();
    const response = await fetch(permission.url, { method: 'POST', headers: { ...permission.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask', arguments: { tool_name: 'Bash', tool_use_id: 'permission-7', input: { command: 'npm install' } } } }), signal: cancellation.signal });
    const result = response.text().catch(() => 'connection closed');
    try {
      const questions = () => fleet.database.message.findMany({ where: { senderShipId: scout, selectorShipId: owner, contentType: 'application/vnd.aeolus.question+json' } });
      await expect.poll(async () => (await questions()).length, { timeout: ANSWERED_WITHIN_MS }).toBe(1);
      const question = (await questions())[0];
      expect(question?.model).toBe('claude-opus-5');
      const payload = questionSchema.parse(JSON.parse(question?.payload ?? '{}'));
      expect(payload.title).toBe('Run `npm install`');
      expect(payload.context).toContain('scout');
      expect(payload.context).toContain('npm install');
      expect(payload.options.map(({ label }) => label)).toEqual(['Allow once', 'Allow for this session', 'Deny']);
      expect(payload.pick).toEqual({ option: 3, why: 'nothing runs without your yes' });
      expect(await fleet.database.delivery.count({ where: { messageId: question?.id, recipientShipId: owner, state: 'pending' } })).toBe(1);
      if (end === 'ship is released') {
        await fleet.removeCrewRequest(scout);
      } else {
        cancellation.abort();
      }
      await result;
      await expect.poll(() => fleet.database.message.count({ where: { senderShipId: scout, selectorShipId: owner, contentType: 'application/vnd.aeolus.question-withdrawal+json', payload: JSON.stringify({ questionId: payload.id }) } }), { timeout: ANSWERED_WITHIN_MS }).toBe(1);
    } finally {
      cancellation.abort();
      await result;
    }
  });
});


describe.skipIf(isTodaysTrierarch)('permission answer hand-over', () => {
  it('takes the owner answer before hand-over while other messages and rejected answers wait for the next turn', async () => {
    const owner = await fleet.commission('person');
    await fleet.database.ship.update({ where: { id: owner }, data: { kind: 'person' } });
    const stranger = await fleet.commission('stranger');
    const scout = await fleet.commission('scout', { owner });
    const config = join(machine.trierarchHome, 'config.json');
    const configuration = z.looseObject({ harnesses: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(config, 'utf8')));
    writeFileSync(config, JSON.stringify({ ...configuration, harnesses: { ...configuration.harnesses, 'claude-code': { flags: [], options: {} } } }));
    expect((await machine.trierarch(['restart'])).status).toBe(0);
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code', options: { model: 'claude-opus-5' } });
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: ANSWERED_WITHIN_MS }).toBe('running');
    const session = sessionOf(machine, 'scout');
    const task = await fleet.send('scout', 'work on the permission test');
    await expect.poll(() => fleet.deliveryStateOf(task), { timeout: ANSWERED_WITHIN_MS }).toBe('handled');
    // A tool call runs inside a busy turn. Drive the real hook because this
    // contract's stand-in does not itself call the private permission tool.
    const hook = await runProgram(['bash', join(PLUGIN_ROOT, 'scripts', 'aeolus-turn.sh')], { cwd: session.folder, env: { ...session.starts()[0]?.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: machine.pluginData, CLAUDE_PROJECT_DIR: session.folder }, input: JSON.stringify({ cwd: session.folder, hook_event_name: 'UserPromptSubmit', prompt: 'permission test' }) });
    expect(hook.status).toBe(0);
    const servers = z.object({ mcpServers: z.record(z.string(), z.object({ url: z.string(), headers: z.record(z.string(), z.string()) })) }).parse(JSON.parse(readFileSync(join(machine.trierarchHome, 'sessions', scout, 'mcp-config.json'), 'utf8')));
    const permission = servers.mcpServers['aeolus-permissions'];
    if (permission === undefined) throw new Error('permission server is missing');
    const cancellation = new AbortController();
    const response = await fetch(permission.url, { method: 'POST', headers: { ...permission.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'ask', arguments: { tool_name: 'Bash', tool_use_id: 'permission-8', input: { command: 'npm ci' } } } }), signal: cancellation.signal });
    const result = response.text();
    void result.catch(() => undefined);
    try {
      const questions = () => fleet.database.message.findMany({ where: { senderShipId: scout, selectorShipId: owner, contentType: 'application/vnd.aeolus.question+json' } });
      await expect.poll(async () => (await questions()).length, { timeout: ANSWERED_WITHIN_MS }).toBe(1);
      const question = (await questions())[0];
      if (question === undefined) throw new Error('question is missing');
      const payload = questionSchema.parse(JSON.parse(question.payload ?? '{}'));
      const answer = async (sender: ShipId, kind: ShipCaller['kind']) => {
        const caller: ShipCaller = { shipId: sender, fleetId: fleet.argo.fleetId, kind, scopes: fleet.argo.scopes };
        return unwrap(await fleet.useCases.sendMessage(caller, { selector: { kind: 'ship', shipId: scout }, contentType: 'application/vnd.aeolus.answer+json', payload: JSON.stringify({ questionId: payload.id, option: 1, note: sender === stranger ? 'stranger answer' : 'owner answer' }), inReplyTo: idSchema('message').parse(question.id), ...(kind === 'agent' ? { model: 'test-agent' } : {}), idempotencyKey: newKey() })).messageId;
      };
      await fleet.send('scout', 'ordinary message while busy');
      const rejected = await answer(stranger, 'agent');
      await expect.poll(() => fleet.deliveryStateOf(rejected), { timeout: ANSWERED_WITHIN_MS }).toBe('acknowledged');
      const accepted = await answer(owner, 'person');
      await expect.poll(() => fleet.deliveryStateOf(accepted), { timeout: ANSWERED_WITHIN_MS }).toBe('handled');
      const text = await result;
      expect(text).toContain(String.raw`\"behavior\":\"allow\"`);
      expect(session.turns().some(({ context }) => context.includes('owner answer'))).toBe(false);
      unwrap(await fleet.useCases.sendMessage(fleet.argo, { selector: { kind: 'ship', shipId: scout }, payload: 'end the prior turn', isForced: true, idempotencyKey: newKey() }));
      await expect.poll(() => session.turns().some(({ context }) => context.includes('stranger answer')), { timeout: ANSWERED_WITHIN_MS }).toBe(true);
      await expect.poll(() => session.turns().some(({ context }) => context.includes('ordinary message while busy')), { timeout: ANSWERED_WITHIN_MS }).toBe(true);
      expect(session.turns().some(({ context }) => context.includes('owner answer'))).toBe(false);
    } finally {
      cancellation.abort();
      await result.catch(() => undefined);
    }
  });
});


// The model endpoint is deterministic; the installed Claude Code executes its
// real tools and receives answers sent by a person ship in the real test core.
describe.skipIf(isTodaysTrierarch || process.env.AEOLUS_TEST_CLAUDE_CODE !== '1')('real Claude Code permission answers', () => {
  it.each([1, 2, 3])('a person answers option %s and the real session obeys it', async (option) => {
    const owner = await fleet.commission('person');
    await fleet.database.ship.update({ where: { id: owner }, data: { kind: 'person' } });
    const scout = await fleet.commission('scout', { owner });
    const config = join(machine.trierarchHome, 'config.json');
    const configuration = z.looseObject({ harnesses: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(config, 'utf8')));
    writeFileSync(config, JSON.stringify({ ...configuration, harnesses: { ...configuration.harnesses, 'claude-code': { flags: [], options: {} } } }));
    expect((await machine.trierarch(['restart'])).status).toBe(0);
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code', options: { model: 'claude-opus-5' } });
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: ANSWERED_WITHIN_MS }).toBe('running');
    const task = await fleet.send('scout', 'prepare the permission test');
    await expect.poll(() => fleet.deliveryStateOf(task), { timeout: ANSWERED_WITHIN_MS }).toBe('handled');
    const session = sessionOf(machine, 'scout');
    const hook = await runProgram(['bash', join(PLUGIN_ROOT, 'scripts', 'aeolus-turn.sh')], { cwd: session.folder, env: { ...session.starts()[0]?.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: machine.pluginData, CLAUDE_PROJECT_DIR: session.folder }, input: JSON.stringify({ cwd: session.folder, hook_event_name: 'UserPromptSubmit', prompt: 'permission test' }) });
    expect(hook.status).toBe(0);
    const folder = join(machine.home, 'real-claude');
    const claudeConfig = join(folder, 'claude');
    mkdirSync(claudeConfig, { recursive: true });
    writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
    const target = join(folder, 'owner-approved.txt');
    let calls = 0;
    const vendor = createServer((request, response) => {
      if (!new URL(request.url ?? '/', 'http://model').pathname.endsWith('/messages')) { response.end(JSON.stringify({ input_tokens: 1 })); return; }
      calls += 1;
      const shouldWrite = calls === 1 || (calls === 2 && option !== 3);
      realModelReply(response, { call: calls, input: shouldWrite ? { file_path: target, content: String(calls) } : undefined });
    });
    await new Promise<void>((resolve) => vendor.listen(0, '127.0.0.1', resolve));
    const address = vendor.address();
    if (address === null || typeof address === 'string') throw new Error('model endpoint did not listen');
    const cancellation = new AbortController();
    const timeout = setTimeout(() => { cancellation.abort(); }, ANSWERED_WITHIN_MS);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !name.startsWith('ANTHROPIC_') && !name.startsWith('CLAUDE_') && name !== 'CLAUDECODE'));
    const child = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-6', '--setting-sources', '', '--strict-mcp-config', '--permission-mode', 'default', '--permission-prompt-tool', 'mcp__aeolus-permissions__ask', '--mcp-config', join(machine.trierarchHome, 'sessions', scout, 'mcp-config.json'), '--', 'Do the requested writes.'], { cwd: folder, env: { ...environment, CLAUDE_CONFIG_DIR: claudeConfig, ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(address.port)}`, ANTHROPIC_API_KEY: 'test-model-key', ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
    const ended = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', (code) => { resolve(code); }); });
    void ended.catch(() => undefined);
    const answered = new Set<string>();
    const answering = (async () => {
      while (child.exitCode === null && child.signalCode === null && !cancellation.signal.aborted) {
        const questions = await fleet.database.message.findMany({ where: { senderShipId: scout, selectorShipId: owner, contentType: 'application/vnd.aeolus.question+json' } });
        for (const question of questions) {
          if (answered.has(question.id)) continue;
          const payload = questionSchema.parse(JSON.parse(question.payload ?? '{}'));
          const person: ShipCaller = { shipId: owner, fleetId: fleet.argo.fleetId, kind: 'person', scopes: fleet.argo.scopes };
          unwrap(await fleet.useCases.sendMessage(person, { selector: { kind: 'ship', shipId: scout }, contentType: 'application/vnd.aeolus.answer+json', inReplyTo: idSchema('message').parse(question.id), payload: JSON.stringify({ questionId: payload.id, option, ...(option === 3 ? { note: 'The person refused this write.' } : {}) }), idempotencyKey: newKey() }));
          answered.add(question.id);
        }
        await wait(50);
      }
    })();
    void answering.catch(() => { cancellation.abort(); });
    try {
      expect(await ended, errors + output).toBe(0);
      await answering;
      expect(answered.size).toBe(option === 1 ? 2 : 1);
      expect(existsSync(target)).toBe(option !== 3);
      if (option !== 3) expect(readFileSync(target, 'utf8')).toBe('2');
      if (option === 3) expect(output).toContain('The person refused this write.');
      expect(session.turns().some(({ context }) => context.includes('application/vnd.aeolus.answer+json'))).toBe(false);
      const replies = await fleet.database.message.findMany({ where: { senderShipId: owner, selectorShipId: scout, contentType: 'application/vnd.aeolus.answer+json' } });
      for (const reply of replies) expect(await fleet.deliveryStateOf(reply.id)).toBe('handled');
    } finally {
      clearTimeout(timeout);
      cancellation.abort();
      await Promise.allSettled([ended, answering]);
      await new Promise<void>((resolve) => vendor.close(() => { resolve(); }));
    }
  }, 90_000);
});

function realModelReply(response: ServerResponse, at: { call: number; input: { file_path: string; content: string } | undefined }): void {
  const { call, input } = at;
  const block = input === undefined ? { type: 'text', text: '' } : { type: 'tool_use', id: `toolu_owner_${String(call)}`, name: 'Write', input: {} };
  const delta = input === undefined ? { type: 'text_delta', text: 'Done.' } : { type: 'input_json_delta', partial_json: JSON.stringify(input) };
  const stop = input === undefined ? 'end_turn' : 'tool_use';
  response.setHeader('Content-Type', 'text/event-stream');
  const events: readonly (readonly [string, unknown])[] = [
    ['message_start', { type: 'message_start', message: { id: `msg_model_${String(call)}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  for (const [name, value] of events) response.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  response.end();
}


describe.skipIf(isTodaysTrierarch)('a withdrawn permission question', () => {
  it('hands its late answer as an ordinary message and logs the sender', async () => {
    const { owner, scout, permission } = await aPermissionSession();
    const cancellation = new AbortController();
    const response = await fetch(permission.url, { method: 'POST', headers: { ...permission.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'ask', arguments: { tool_name: 'Bash', tool_use_id: 'permission-late', input: { command: 'npm ci' } } } }), signal: cancellation.signal });
    const result = response.text().catch(() => 'connection closed');
    try {
      const question = () => fleet.database.message.findFirst({ where: { senderShipId: scout, selectorShipId: owner, contentType: 'application/vnd.aeolus.question+json' } });
      await expect.poll(question, { timeout: ANSWERED_WITHIN_MS }).not.toBeNull();
      const asked = await question();
      if (asked === null) throw new Error('question is missing');
      const payload = questionSchema.parse(JSON.parse(asked.payload ?? '{}'));
      cancellation.abort();
      await result;
      await expect.poll(() => fleet.database.message.count({ where: { senderShipId: scout, contentType: 'application/vnd.aeolus.question-withdrawal+json', payload: JSON.stringify({ questionId: payload.id }) } }), { timeout: ANSWERED_WITHIN_MS }).toBe(1);
      const person: ShipCaller = { shipId: owner, fleetId: fleet.argo.fleetId, kind: 'person', scopes: fleet.argo.scopes };
      const late = unwrap(await fleet.useCases.sendMessage(person, { selector: { kind: 'ship', shipId: scout }, contentType: 'application/vnd.aeolus.answer+json', inReplyTo: idSchema('message').parse(asked.id), payload: JSON.stringify({ questionId: payload.id, option: 1, note: 'Late answer to the withdrawn ask.' }), idempotencyKey: newKey() })).messageId;
      await expect.poll(() => fleet.deliveryStateOf(late), { timeout: ANSWERED_WITHIN_MS }).toBe('handled');
      expect(sessionOf(machine, 'scout').turns().some(({ context }) => context.includes('Late answer to the withdrawn ask.'))).toBe(true);
      expect(readFileSync(join(machine.pluginData, 'logs', 'aeolus.log'), 'utf8')).toContain('answer from person');
    } finally {
      cancellation.abort();
      await result;
    }
  });
});

async function aPermissionSession(): Promise<{ owner: ShipId; scout: ShipId; permission: { url: string; headers: Record<string, string> } }> {
  const owner = await fleet.commission('person');
  await fleet.database.ship.update({ where: { id: owner }, data: { kind: 'person' } });
  const scout = await fleet.commission('scout', { owner });
  const config = join(machine.trierarchHome, 'config.json');
  const configuration = z.looseObject({ harnesses: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(config, 'utf8')));
  writeFileSync(config, JSON.stringify({ ...configuration, harnesses: { ...configuration.harnesses, 'claude-code': { flags: [], options: {} } } }));
  expect((await machine.trierarch(['restart'])).status).toBe(0);
  await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code', options: { model: 'claude-opus-5' } });
  await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: ANSWERED_WITHIN_MS }).toBe('running');
  const servers = z.object({ mcpServers: z.record(z.string(), z.object({ url: z.string(), headers: z.record(z.string(), z.string()) })) }).parse(JSON.parse(readFileSync(join(machine.trierarchHome, 'sessions', scout, 'mcp-config.json'), 'utf8')));
  const permission = servers.mcpServers['aeolus-permissions'];
  if (permission === undefined) throw new Error('permission server is missing');
  return { owner, scout, permission };
}
