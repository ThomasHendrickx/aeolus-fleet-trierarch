/** Cursor's native hooks, using the captured CLI payloads and the same fleet/store scripts as the other harnesses. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { scriptEnvironment } from './script-environment.js';
import { startRoutedStubFleet, type StubFleet } from './stub-fleet.js';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../../..', import.meta.url));
const SHIP = 'shp_01m3tbfspe96yf1rnr4ank9h1a';
const DELIVERY = 'dlv_01m4raygfdtsjfbnmpvqjznsyw';
let home: string;
let folder: string;
let fleet: StubFleet | undefined;
const json = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
const hooks = () => z.object({ version: z.literal(1), hooks: z.record(z.string(), z.array(z.object({ command: z.string(), matcher: z.string().optional() }))) }).parse(json(join(PLUGIN, 'hooks/cursor-hooks.json'))).hooks;
const data = () => join(home, '.aeolus/plugins/cursor/aeolus-fleet');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aeolus-cursor-home-'));
  folder = mkdtempSync(join(tmpdir(), 'aeolus cursor folder-'));
});
afterEach(async () => {
  await fleet?.close();
  fleet = undefined;
  rmSync(home, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

function command(script: string, options: string[] | { args: string[]; input: string } = []) {
  const args = Array.isArray(options) ? options : options.args;
  const input = Array.isArray(options) ? '' : options.input;
  return spawnSync('bash', [join(PLUGIN, 'scripts', script), ...args], { cwd: folder, encoding: 'utf8', input, env: scriptEnvironment({ HOME: home, AEOLUS_HARNESS: 'cursor', AEOLUS_DATA: data(), AEOLUS_FOLDER: folder }) });
}
function crew(url = 'https://fleet.example.com', squadron?: string) {
  expect(command('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', url, SHIP, 'scout', ...(squadron === undefined ? [] : [squadron])], input: 'aeolus_ct_v1_test' }).status).toBe(0);
}

/** Runs the packaged commands as Cursor does, with Cursor's environment and no foreign harness variables. */
async function hook(event: string, payload: Record<string, unknown> = {}) {
  const outputs: string[] = [];
  for (const entry of hooks()[event] ?? []) {
    const child = spawn('bash', ['-c', entry.command], { cwd: folder, env: scriptEnvironment({ HOME: home, CURSOR_PLUGIN_ROOT: PLUGIN, AEOLUS_LAUNCH: 'launch-cursor' }) });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stdin.end(JSON.stringify({ hook_event_name: event, workspace_roots: [folder], model: 'default', ...payload }));
    const status = await new Promise((resolve) => child.on('close', resolve));
    expect(status).toBe(0);
    if (stdout.trim() !== '') outputs.push(stdout.trim());
  }
  return outputs;
}

async function handed() {
  fleet = await startRoutedStubFleet({
    '/api/v1/ship/pushReceive': [{ status: 200, body: { deliveries: [{ deliveryId: DELIVERY, messageId: 'msg_01m4raygfdtsjfbnmpvqjznsyv', senderShipId: SHIP, senderName: 'orchestrator-1', senderType: 'orchestrator', recipient: { kind: 'ship', shipId: SHIP }, payload: 'Review PR 12', contentType: 'text/plain', model: 'auto', inReplyTo: null, sentAt: '2026-11-16T12:00:00.000Z', attempts: 1 }] } }],
    '/api/v1/ship/handed': [{ status: 200, body: { state: 'handed' } }],
    '/api/v1/ship/ack': [{ status: 200, body: {} }],
    '/api/v1/ship/handled': [{ status: 200, body: {} }],
    '/api/v1/ship/turn': [{ status: 200, body: {} }],
  });
  crew(fleet.url);
  const child = spawn('bash', [join(PLUGIN, 'scripts/aeolus-push.sh'), 'hand'], { cwd: folder, env: scriptEnvironment({ HOME: home, AEOLUS_HARNESS: 'cursor', AEOLUS_DATA: data(), AEOLUS_FOLDER: folder }) });
  expect(await new Promise((resolve) => child.on('close', resolve))).toBe(0);
  return fleet;
}

const calls = (path: string) => fleet?.calls.filter((call) => call.path === path) ?? [];
const sibling = (suffix: string) => command('aeolus-identity.sh', ['path']).stdout.trim().replace(/\.identity$/u, suffix);

describe('the Cursor plugin package (CC5)', () => {
  it('publishes a native manifest and marketplace with the shared crew skill and no Claude Code commands', () => {
    const manifest = z.object({ name: z.literal('aeolus-fleet'), version: z.string(), hooks: z.literal('./hooks/cursor-hooks.json'), skills: z.tuple([z.literal('./skills/crew-a-ship')]), commands: z.array(z.string()) }).parse(json(join(PLUGIN, '.cursor-plugin/plugin.json')));
    expect(manifest.version).toBe(z.object({ version: z.string() }).parse(json(join(PLUGIN, '.claude-plugin/plugin.json'))).version);
    expect(manifest.commands).toEqual([]);
    expect(z.object({ plugins: z.array(z.object({ name: z.string(), source: z.string() })) }).parse(json(join(REPOSITORY, '.cursor-plugin/marketplace.json'))).plugins).toEqual([{ name: 'aeolus-fleet', source: './plugins/aeolus-fleet' }]);
  });

  it('maps only proven Cursor roles to shared scripts with an explicit cursor harness and plugin root', () => {
    const mapping = hooks();
    expect(Object.keys(mapping).sort()).toEqual(['postToolUse', 'preToolUse', 'sessionEnd', 'sessionStart']);
    expect(mapping.sessionEnd?.map(({ command: line }) => line.split('/').at(-1))).toEqual(['aeolus-stop.sh"', 'aeolus-turn-died.sh"']);
    for (const entry of Object.values(mapping).flat()) {
      expect(entry.command).toContain('AEOLUS_HARNESS=cursor');
      expect(entry.command).toContain('${CURSOR_PLUGIN_ROOT}/scripts/');
    }
  });
});

describe('Cursor native hook behavior', () => {
  it('keeps the Cursor identity apart and emits start context in additional_context, marking started', async () => {
    await handed();
    expect(command('aeolus-identity.sh', ['path']).stdout).toContain(join(home, '.aeolus/crews/cursor'));
    const outputs = await hook('sessionStart');
    const context = z.object({ additional_context: z.string() }).parse(JSON.parse(outputs[0] ?? '{}')).additional_context;
    expect(context).toContain('Aeolus Fleet Cursor hooks are active.');
    expect(context).toContain('This folder crews the Aeolus ship scout');
    expect(context).toContain('AEOLUS_HARNESS=cursor');
    expect(context).toContain('Receive and ack nothing');
    expect(context).toContain('start no watcher');
    expect(context).not.toContain('aeolus_ct_v1_test');
    expect(readFileSync(sibling('.launch'), 'utf8')).toContain('started ');
  });

  it('uses workspace_roots when a tool cwd is a subfolder and records the captured default model as auto', async () => {
    crew();
    await hook('preToolUse', { cwd: join(folder, 'subfolder'), tool_name: 'Shell', tool_input: { command: 'aeolus-fleet.sh send -' } });
    expect(readFileSync(sibling('.launch'), 'utf8')).toContain('active ');
    expect(readFileSync(sibling('.model'), 'utf8').trim()).toBe('auto');
  });

  it('denies the first tool after the fleet acknowledges the handed message, using agent_message', async () => {
    await handed();
    const outputs = await hook('preToolUse', { tool_name: 'Shell', tool_input: { command: 'printf probe' } });
    const denied = z.object({ permission: z.literal('deny'), agent_message: z.string() }).parse(JSON.parse(outputs[0] ?? '{}'));
    expect(denied.agent_message).toContain('Review PR 12');
    expect(calls('/api/v1/ship/ack')).toHaveLength(1);
  });

  it('confirms and handles a tool-free hand-over at sessionEnd completed, without stop output or watcher', async () => {
    await handed();
    expect(await hook('sessionEnd', { final_status: 'completed', reason: 'completed' })).toEqual([]);
    expect(calls('/api/v1/ship/ack')).toHaveLength(1);
    expect(calls('/api/v1/ship/handled')).toHaveLength(1);
  });

  it('leaves a merely received message for the next turn when sessionEnd completes', async () => {
    await handed();
    const state = sibling('.store') + '/' + DELIVERY + '.state';
    writeFileSync(state, 'received\n');
    await hook('sessionEnd', { final_status: 'completed' });
    expect(calls('/api/v1/ship/ack')).toEqual([]);
    expect(readFileSync(state, 'utf8').trim()).toBe('received');
  });

  it.each(['error', 'aborted'])('keeps a confirmed hand-over for once more after final_status %s', async (status) => {
    await handed();
    await hook('preToolUse', { tool_name: 'Shell' });
    expect(await hook('sessionEnd', { final_status: status, reason: status })).toEqual([]);
    expect(command('aeolus-identity.sh', ['store']).stdout).toContain(`${DELIVERY} onceMore`);
    expect(calls('/api/v1/ship/handled')).toEqual([]);
  });

  it('does not classify an unknown sessionEnd status as completed', async () => {
    await handed();
    await hook('sessionEnd', { final_status: 'unknown' });
    expect(calls('/api/v1/ship/ack')).toEqual([]);
    expect(calls('/api/v1/ship/handled')).toEqual([]);
  });

  it('preserves confirmed work when the trierarch interrupted for a forced hand-over', async () => {
    await handed();
    await hook('preToolUse', { tool_name: 'Shell' });
    writeFileSync(sibling('.turn.forcedStop'), 'forced\n');
    await hook('sessionEnd', { final_status: 'error', reason: 'error' });
    expect(command('aeolus-identity.sh', ['store']).stdout).toContain(`${DELIVERY} confirmed`);
  });

  it('adds the report reminder as native additional_context', async () => {
    crew('https://fleet.example.com', 'sqd_01m4w1t3c6m6q7v9hq0hq0q0q0q0');
    expect(command('aeolus-identity.sh', ['check-in', '1m']).status).toBe(0);
    writeFileSync(sibling('.reported'), '1\n');
    const outputs = await hook('postToolUse', { tool_name: 'Shell' });
    expect(z.object({ additional_context: z.string() }).parse(JSON.parse(outputs[0] ?? '{}')).additional_context).toContain('the check-in interval');
  });
});
