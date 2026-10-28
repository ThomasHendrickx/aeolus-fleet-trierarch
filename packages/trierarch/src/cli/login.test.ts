import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKeyFiles, type KeyFiles } from '../adapters/key-files.js';
import type { PluginHarness } from '../adapters/plugin.js';
import type { ServiceStatus } from '../adapters/service.js';
import type { KeyCheck } from '../adapters/vendor-key-check.js';
import { login, readKeyFrom, type LoginRequest } from './login.js';

/** A made-up key: no test holds a real one. */
const KEY = 'test-key-not-real';

let home: string;
let keys: KeyFiles;
let checked: { harness: PluginHarness; key: string }[];
let answer: KeyCheck;
let restarts: number;
let isServiceInstalled: boolean;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-login-'));
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
    expect(report.said).toEqual(['Claude Code  default Subscription  API key ready', 'Codex        default Subscription  no API key']);
    expect(restarts).toBe(0);
    expect(checked).toEqual([]);
  });
});

describe('reading the key', () => {
  it('takes what is piped in, without the line end', async () => {
    await expect(readKeyFrom(Readable.from([`${KEY}\n`]))).resolves.toBe(KEY);
  });
});
