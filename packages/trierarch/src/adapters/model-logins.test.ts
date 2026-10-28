import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKeyFiles, type KeyFiles } from './key-files.js';
import { createModelLogins } from './model-logins.js';

/** Claude Code's settings and Codex's login as a test gives them: no key in reach unless it says so. */
let keyInReach: string | undefined;
let codexLogin: 'chatgpt' | 'apiKey' | 'none';
let askedFolders: (string | undefined)[];
const harnesses = () => ({
  claudeCode: { keyInReach: (at: { folder?: string }) => { askedFolders.push(at.folder); return Promise.resolve(keyInReach); } },
  codex: { loginKind: () => Promise.resolve(codexLogin) },
});

let home: string;
let keys: KeyFiles;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-model-logins-'));
  keys = createKeyFiles(join(home, 'keys'));
  keyInReach = undefined;
  codexLogin = 'chatgpt';
  askedFolders = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('whether a session can start on its login (api keys K9)', () => {
  it('on the subscription, always', async () => {
    await expect(createModelLogins({ keys, runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'subscription' })).resolves.toBeUndefined();
  });

  it('on an API key, once the harness holds one', async () => {
    await keys.write('claude-code', 'test-key-not-real');

    await expect(createModelLogins({ keys, runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'apiKey' })).resolves.toBeUndefined();
  });

  it('not on an API key the harness does not hold, saying how to give it one', async () => {
    await expect(createModelLogins({ keys, runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'apiKey' })).resolves.toBe('claude-code has no API key on this computer: aeolus-trierarch login claude-code --api-key');
  });

  it('for Codex on an API key once it holds one, as for Claude Code', async () => {
    await keys.write('codex', 'test-key-not-real');

    await expect(createModelLogins({ keys, runtime: 'host', ...harnesses() }).startProblem({ harness: 'codex', login: 'apiKey' })).resolves.toBeUndefined();
    await expect(createModelLogins({ keys, runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'apiKey' })).resolves.toBe('claude-code has no API key on this computer: aeolus-trierarch login claude-code --api-key');
  });

  it('not on an API key with the container runtime yet', async () => {
    await keys.write('claude-code', 'test-key-not-real');

    await expect(createModelLogins({ keys, runtime: 'container', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'apiKey' })).resolves.toBe('a session on an API key runs on the host runtime only, until containers reach the model proxy');
  });

  it("not on Claude Code's subscription with a key in reach of it, naming where, in the folder it starts in", async () => {
    keyInReach = 'apiKeyHelper in /home/thomas/.claude/settings.json';

    await expect(createModelLogins({ keys, runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'subscription', folder: '/work/scout' })).resolves.toBe(
      'claude-code would reach an API key on its subscription (apiKeyHelper in /home/thomas/.claude/settings.json): remove it, or run the ship on its API key',
    );
    expect(askedFolders).toEqual(['/work/scout']);
  });

  it("not on Codex's subscription while Codex is logged in with an API key", async () => {
    codexLogin = 'apiKey';

    await expect(createModelLogins({ keys, runtime: 'host', ...harnesses() }).startProblem({ harness: 'codex', login: 'subscription' })).resolves.toBe(
      'codex is logged in with an API key, not ChatGPT: log Codex in with ChatGPT (codex logout, then codex login), or run the ship on its API key',
    );
  });

  it('on an API key whatever the subscription would reach', async () => {
    keyInReach = 'apiKeyHelper in /home/thomas/.claude/settings.json';
    codexLogin = 'apiKey';
    await keys.write('claude-code', 'test-key-not-real');

    await expect(createModelLogins({ keys, runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'apiKey' })).resolves.toBeUndefined();
  });
});

