import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initialConfiguration, trierarchConfigurationSchema } from '../adapters/files.js';
import { createKeyFiles, type KeyFiles } from '../adapters/key-files.js';
import type { PluginHarness } from '../adapters/plugin.js';
import type { ServiceStatus } from '../adapters/service.js';
import type { KeyCheck } from '../adapters/vendor-key-check.js';
import type { KeyStateAt } from '../core/login.js';
import { login, readKeyFrom, type LoginRequest } from './login.js';

/** A made-up key: no test holds a real one. */
const KEY = 'test-key-not-real';

let home: string;
let keys: KeyFiles;
let checked: { harness: PluginHarness; key: string }[];
let answer: KeyCheck;
let restarts: number;
let isServiceInstalled: boolean;
let config: string;
/** What the model proxy answers a check with, by harness; none when it does not run. */
let checkedStates: Map<string, KeyStateAt> | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-login-'));
  config = join(home, 'config.json');
  checkedStates = new Map();
  writeFileSync(config, JSON.stringify({ ...initialConfiguration(), worktreeRoot: '/kept/as/written' }));
  keys = createKeyFiles(join(home, 'keys'));
  checked = [];
  answer = { kind: 'taken' };
  restarts = 0;
  isServiceInstalled = true;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(request: LoginRequest, key = KEY) {
  return login({
    request,
    config,
    keys,
    readKey: () => Promise.resolve(key),
    check: (harness, given) => {
      checked.push({ harness, key: given });
      return Promise.resolve(answer);
    },
    service: {
      status: (): Promise<ServiceStatus> => Promise.resolve({ file: '/systemd/aeolus-trierarch.service', isInstalled: isServiceInstalled, isRunning: isServiceInstalled, pid: 2 }),
      restart: () => {
        restarts += 1;
        return Promise.resolve();
      },
    },
    running: () => Promise.resolve({ pid: 2, version: '0.34.0' }),
    checkNow: (harness) => (checkedStates === undefined ? Promise.resolve(undefined) : Promise.resolve(checkedStates.get(harness) ?? { state: 'ready' })),
    sleep: () => Promise.resolve(),
  });
}

describe('aeolus-trierarch login', () => {
  it('writes a key the vendor takes, then restarts the service (api keys K11)', async () => {
    const report = await run({ kind: 'apiKey', harness: 'claude-code' });

    expect(checked).toEqual([{ harness: 'claude-code', key: KEY }]);
    expect(readFileSync(join(home, 'keys', 'claude-code'), 'utf8')).toBe(KEY);
    expect(restarts).toBe(1);
    expect(report.said).toEqual(['The vendor took the API key for Claude Code; it is kept on this computer only.', 'The trierarch restarted; its sessions kept running.']);
  });

  it("writes nothing when the vendor refuses the key, and says the vendor's cause", async () => {
    answer = { kind: 'refused', cause: 'Anthropic refused the key: 401 authentication_error' };

    await expect(run({ kind: 'apiKey', harness: 'claude-code' })).rejects.toThrow('Anthropic refused the key: 401 authentication_error. Nothing was written.');

    await expect(keys.has('claude-code')).resolves.toBe(false);
    expect(restarts).toBe(0);
  });

  it('keeps the key it had when the vendor refuses a new one (api keys, unhappy paths)', async () => {
    await keys.write('codex', 'test-key-kept');
    answer = { kind: 'refused', cause: 'OpenAI refused the key: 401 invalid_api_key' };

    await expect(run({ kind: 'apiKey', harness: 'codex' })).rejects.toThrow('Nothing was written');

    expect(readFileSync(join(home, 'keys', 'codex'), 'utf8')).toBe('test-key-kept');
  });

  it('writes nothing when the vendor cannot be reached', async () => {
    answer = { kind: 'unreachable', cause: 'OpenAI could not be reached at https://api.openai.com: fetch failed' };

    await expect(run({ kind: 'apiKey', harness: 'codex' })).rejects.toThrow('OpenAI could not be reached at https://api.openai.com: fetch failed. Nothing was written.');

    await expect(keys.has('codex')).resolves.toBe(false);
  });

  it('refuses an empty key without asking the vendor', async () => {
    await expect(run({ kind: 'apiKey', harness: 'codex' }, '')).rejects.toThrow('No API key came in: pipe it in, or type it when asked.');

    expect(checked).toEqual([]);
  });

  it('never says the key (api keys K7)', async () => {
    const report = await run({ kind: 'apiKey', harness: 'codex' });

    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it('removes a key, then restarts the service', async () => {
    await keys.write('codex', KEY);

    const report = await run({ kind: 'removeKey', harness: 'codex' });

    await expect(keys.has('codex')).resolves.toBe(false);
    expect(restarts).toBe(1);
    expect(report.said[0]).toBe('Removed the API key for Codex.');
  });

  it('changes nothing and restarts nothing when there is no key to remove', async () => {
    const report = await run({ kind: 'removeKey', harness: 'codex' });

    expect(restarts).toBe(0);
    expect(report.said).toEqual(['Codex holds no API key: nothing to remove.']);
  });

  it('says how to run the service when it is not installed', async () => {
    isServiceInstalled = false;

    const report = await run({ kind: 'apiKey', harness: 'codex' });

    expect(restarts).toBe(0);
    expect(report.said.at(-1)).toBe('The service is not installed: run aeolus-trierarch install to run it.');
  });

  it("alone, gives each harness's default login and whether it holds a key, never the key", async () => {
    await keys.write('claude-code', KEY);

    const report = await run({ kind: 'show' });

    expect(report.harnesses).toEqual([
      { harness: 'claude-code', default: 'subscription', key: 'ready' },
      { harness: 'codex', default: 'subscription', key: 'none' },
    ]);
    expect(report.ships).toEqual([]);
    expect(report.said).toEqual(['Claude Code  default Subscription  API key ready', 'Codex        default Subscription  no API key']);
    expect(restarts).toBe(0);
    expect(checked).toEqual([]);
  });
});

function logins() {
  return trierarchConfigurationSchema.parse(JSON.parse(readFileSync(config, 'utf8'))).logins;
}

describe('aeolus-trierarch login, choosing the login (api keys K5, K11)', () => {
  it("sets a harness's default login in the configuration, keeping the rest of it, then restarts the service", async () => {
    const report = await run({ kind: 'setDefault', harness: 'claude-code', login: 'apiKey' });

    expect(logins()).toEqual({ default: { 'claude-code': 'apiKey' } });
    expect(JSON.parse(readFileSync(config, 'utf8'))).toMatchObject({ worktreeRoot: '/kept/as/written', $schema: './config.schema.json' });
    expect(restarts).toBe(1);
    expect(report.said).toEqual(['Claude Code runs on API key by default, from each session\'s next start.', 'The trierarch restarted; its sessions kept running.']);
  });

  it("sets a ship's exception, and another harness's default beside it", async () => {
    await run({ kind: 'setShip', shipName: 'build-docs', login: 'subscription' });
    const report = await run({ kind: 'setDefault', harness: 'codex', login: 'apiKey' });

    expect(logins()).toEqual({ default: { codex: 'apiKey' }, ships: { 'build-docs': 'subscription' } });
    expect(report.said[0]).toBe('Codex runs on API key by default, from each session\'s next start.');
  });

  it("says a ship's exception from its next start", async () => {
    const report = await run({ kind: 'setShip', shipName: 'build-docs', login: 'apiKey' });

    expect(report.said[0]).toBe("build-docs runs on API key from its next start.");
  });

  it("clears a ship's exception, so it runs on its harness's default", async () => {
    await run({ kind: 'setShip', shipName: 'build-docs', login: 'apiKey' });

    const report = await run({ kind: 'setShip', shipName: 'build-docs', login: 'default' });

    expect(logins()).toEqual({ ships: {} });
    expect(report.said[0]).toBe("build-docs runs on its harness's default from its next start.");
  });

  it('changes nothing and restarts nothing when the login is already so', async () => {
    await run({ kind: 'setDefault', harness: 'codex', login: 'apiKey' });
    restarts = 0;

    const report = await run({ kind: 'setDefault', harness: 'codex', login: 'apiKey' });

    expect(restarts).toBe(0);
    expect(report.said).toEqual(['Codex runs on API key by default already.']);
  });

  it('gives the defaults and each exception it set', async () => {
    await keys.write('codex', KEY);
    await run({ kind: 'setDefault', harness: 'claude-code', login: 'apiKey' });
    await run({ kind: 'setShip', shipName: 'build-docs', login: 'subscription' });
    await run({ kind: 'setShip', shipName: 'build-api', login: 'apiKey' });

    const report = await run({ kind: 'show' });

    expect(report.harnesses).toEqual([
      { harness: 'claude-code', default: 'apiKey', key: 'none' },
      { harness: 'codex', default: 'subscription', key: 'ready' },
    ]);
    expect(report.ships).toEqual([
      { shipName: 'build-api', login: 'apiKey' },
      { shipName: 'build-docs', login: 'subscription' },
    ]);
    expect(report.said).toEqual(['Claude Code  default API key       no API key', 'Codex        default Subscription  API key ready', 'build-api    API key', 'build-docs   Subscription']);
  });
});

describe('aeolus-trierarch login --check (api keys K10)', () => {
  it('says the key is ready once the proxy found the vendor takes it', async () => {
    checkedStates?.set('claude-code', { state: 'ready' });

    const report = await run({ kind: 'check', harness: 'claude-code' });

    expect(report.said).toEqual(["Claude Code's API key is ready: its waiting ships start within a pass."]);
  });

  it('says the key is still out of credit, since when', async () => {
    checkedStates?.set('codex', { state: 'outOfCredit', at: '2026-10-28T14:02:00.000Z' });

    const report = await run({ kind: 'check', harness: 'codex' });

    expect(report.said).toEqual(["Codex's API key is still out of credit since 2026-10-28T14:02:00.000Z. The proxy checks it again every 15 minutes."]);
  });

  it('says to start the service when the proxy does not run', async () => {
    checkedStates = undefined;

    await expect(run({ kind: 'check', harness: 'codex' })).rejects.toThrow('The model proxy does not run: it runs while the service does and a harness holds a key (aeolus-trierarch start).');
  });
});

describe('reading the key', () => {
  it('takes what is piped in, without the line end', async () => {
    await expect(readKeyFrom(Readable.from([`${KEY}\n`]))).resolves.toBe(KEY);
  });
});
