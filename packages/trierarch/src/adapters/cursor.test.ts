/** Cursor's adapter through its public harness port, using the plugin's own identity scripts. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NO_TERMINAL_QUESTIONS, type ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, inRepositories, newId } from '../../test/support/in-memory.js';
import { createCursorHarness } from './cursor.js';
import { createHarnesses, commandLinesOf, riskyFlagsOf } from './harnesses.js';
import { createDetectors } from './detectors.js';
import { createTrust } from './trust.js';

const ROOT = fileURLToPath(new URL('../../../../plugins/aeolus-fleet', import.meta.url));
const VERSION = '2026.11.13-eacade1';
const configuration = { ...CONFIGURATION, harnesses: { cursor: { flags: ['--force'], options: { model: { values: { auto: ['--model', 'auto'] }, default: 'auto' } } } } };
let home: string;
let folder: string;
let lines: string[];
let started: { command: readonly string[]; env?: Readonly<Record<string, string>> }[];
const shipId: ShipId = newId('ship');
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cursor-home-')); folder = mkdtempSync(join(tmpdir(), 'cursor-folder-')); lines = []; started = []; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(folder, { recursive: true, force: true }); });
const sessions = { start: (at: { command: readonly string[]; env?: Readonly<Record<string, string>> }) => { started.push(at); return Promise.resolve(); }, send: () => Promise.resolve(), interrupt: () => Promise.resolve(), events: () => Promise.resolve(lines), lastEventAt: () => Promise.resolve(undefined) };
function harness(at: { version?: string; isInContainer?: boolean; isMissing?: boolean } = {}) {
  return createCursorHarness({ configuration, plugin: { root: () => at.isMissing === true ? Promise.reject(new Error('missing plugin')) : Promise.resolve(ROOT), data: join(home, 'data'), crews: join(home, '.aeolus/crews/cursor') }, sessions, detectedVersion: () => 'version' in at ? at.version : VERSION, isInContainer: at.isInContainer ?? false });
}
const launch = () => ({ shipId, shipName: 'scout', folder, harness: 'cursor', workspace: inRepositories('aeolus-fleet'), launchId: 'cursor-launch', login: 'subscription' as const, options: {}, isFirstStart: true });

describe('Cursor host adapter (CC3, CC4, CC6, CC9, CC10)', () => {
  it('launches the first prompt through the installed plugin and auto without an account key', async () => {
    await harness().launch({ ...launch(), firstPrompt: '-review' });
    expect(started[0]?.command).toEqual(['agent', '--force', '--model', 'auto', '--plugin-dir', ROOT, '--output-format=stream-json', '--trust', '--print', '--', `-review\n\n${NO_TERMINAL_QUESTIONS}`]);
    expect(started[0]?.env).toEqual({ AEOLUS_LAUNCH: 'cursor-launch', AEOLUS_DATA: join(home, 'data'), AEOLUS_CREWS: join(home, '.aeolus/crews/cursor') });
  });

  it('resumes the last initialized chat on restart', async () => {
    lines = ['{"type":"system","subtype":"init","session_id":"chat-1"}'];
    await harness().launch({ ...launch(), isFirstStart: false });
    expect(started[0]?.command).toContain('--resume=chat-1');
    expect(started[0]?.command.at(-1)).not.toContain('-review');
  });

  it('requires the machine login before starting anything', async () => {
    await expect(harness().launch({ ...launch(), login: 'apiKey' })).rejects.toThrow("Cursor signs in with this computer's own login");
    expect(started).toEqual([]);
  });

  it('reads busy and idle only from process boundary events, keeping a vendor result busy', async () => {
    lines = ['{"type":"aeolus.turn","state":"busy"}', '{"type":"result","is_error":false}'];
    await expect(harness().turnOf({ shipId, folder })).resolves.toBe('busy');
    lines.push('{"type":"aeolus.turn","state":"idle","exitStatus":0}');
    await expect(harness().turnOf({ shipId, folder })).resolves.toBe('idle');
  });

  it.each([{ version: undefined }, { version: '2026.11.14-other' }, { isInContainer: true }, { isMissing: true }])('does not offer Cursor when a required condition is missing: %j', async (at) => {
    expect(await harness(at).notOfferedReason()).toBeTruthy();
  });

  it('offers the captured build on the host with its plugin', async () => { await expect(harness().notOfferedReason()).resolves.toBeUndefined(); });

  it('reads the captured model refusal before launch markers', async () => {
    const stderr = readFileSync(new URL('../../../../plugins/aeolus-fleet/test/fixtures/cursor/2026.11.13-eacade1/linux/failed.stderr', import.meta.url), 'utf8').trim();
    lines = [JSON.stringify({ type: 'aeolus.stderr', line: stderr })];
    await expect(harness().launchSeen({ shipId, folder, launchId: 'cursor-launch', model: 's7-nonexistent-model' })).resolves.toEqual({ kind: 'refused', model: 's7-nonexistent-model' });
  });

  it('wires detection, trust, command display and host adapter into the configured machine', async () => {
    const env = { AEOLUS_CURSOR_PLUGIN_ROOT: ROOT };
    const machine = await createHarnesses({ configuration, homeDirectory: home, env, managedSettings: join(home, 'managed'), detected: () => ({ cursor: { version: VERSION, detectedAt: new Date(), confirmedAt: null, options: {} } }), sessions });
    await expect(machine.harnesses.cursor?.notOfferedReason()).resolves.toBeUndefined();
    expect(createDetectors({ homeDirectory: home, env }).cursor).toBeDefined();
    const command = await commandLinesOf({ harness: 'cursor', flags: [], files: { claudeCode: { defaultPermissionMode: () => Promise.resolve(undefined) } }, permissionModes: undefined });
    expect(command?.firstStart.flatMap(({ words }) => words)).toContain('--trust');
    expect(riskyFlagsOf(configuration).cursor).toContain('--force');
    const trusted = await createTrust({ configuration, homeDirectory: home, env, managedSettings: join(home, 'managed') }).trusted();
    expect(trusted.cursor?.repositories).toEqual(Object.keys(configuration.repositories));
  });
});
