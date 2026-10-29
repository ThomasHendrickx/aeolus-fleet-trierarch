import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKeyFiles, type KeyFiles } from './key-files.js';
import { createKeyStates } from './key-states.js';
import { createModelLogins } from './model-logins.js';

/** Claude Code's settings and Codex's login as a test gives them: no key in reach unless it says so. */
let keyInReach: string | undefined;
let codexLogin: 'chatgpt' | 'apiKey' | 'none';
let askedFolders: (string | undefined)[];
let askedOptions: Readonly<Record<string, string>>[];
const harnesses = () => ({
  keyStates: createKeyStates({ keys: join(home, 'keys'), file: join(home, 'proxy', 'key-states.json') }),
  claudeCode: {
    keyInReach: (at: { options: Readonly<Record<string, string>>; folder?: string }) => {
      askedFolders.push(at.folder);
      askedOptions.push(at.options);
      return Promise.resolve(keyInReach);
    },
  },
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
  askedOptions = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('whether a session can start on its login (api keys K9)', () => {
  it('on the subscription, always', async () => {
    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'subscription', options: {} })).resolves.toBeUndefined();
  });

  it('on an API key, once the harness holds one', async () => {
    await keys.write('claude-code', 'test-key-not-real');

    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'apiKey', options: {} })).resolves.toBeUndefined();
  });

  it('not on an API key the harness does not hold, saying how to give it one', async () => {
    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'apiKey', options: {} })).resolves.toBe('claude-code has no API key on this computer: aeolus-trierarch login claude-code --api-key');
  });

  it('for Codex on an API key once it holds one, as for Claude Code', async () => {
    await keys.write('codex', 'test-key-not-real');

    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).startProblem({ harness: 'codex', login: 'apiKey', options: {} })).resolves.toBeUndefined();
    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'apiKey', options: {} })).resolves.toBe('claude-code has no API key on this computer: aeolus-trierarch login claude-code --api-key');
  });

  it("not Copilot on an API key: it signs in with the computer's own login (CC6)", async () => {
    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).startProblem({ harness: 'copilot', login: 'apiKey', options: {} })).resolves.toBe("copilot signs in with this computer's own login and runs on no API key: run the ship on its subscription");
  });

  it('not on an API key with the container runtime yet', async () => {
    await keys.write('claude-code', 'test-key-not-real');

    await expect(createModelLogins({ runtime: 'container', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'apiKey', options: {} })).resolves.toBe('a session on an API key runs on the host runtime only, until containers reach the model proxy');
  });

  it("not on Claude Code's subscription with a key in reach of it, naming where, in the folder it starts in", async () => {
    keyInReach = 'apiKeyHelper in /home/thomas/.claude/settings.json';

    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'subscription', options: { profile: 'keyed' }, folder: '/work/scout' })).resolves.toBe(
      'claude-code would reach an API key on its subscription (apiKeyHelper in /home/thomas/.claude/settings.json): remove it, or run the ship on its API key',
    );
    expect(askedFolders).toEqual(['/work/scout']);
    expect(askedOptions).toEqual([{ profile: 'keyed' }]);
  });

  it("not on Codex's subscription while Codex is logged in with an API key", async () => {
    codexLogin = 'apiKey';

    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).startProblem({ harness: 'codex', login: 'subscription', options: {} })).resolves.toBe(
      'codex is logged in with an API key, not ChatGPT: log Codex in with ChatGPT (codex logout, then codex login), or run the ship on its API key',
    );
  });

  it('on an API key whatever the subscription would reach', async () => {
    keyInReach = 'apiKeyHelper in /home/thomas/.claude/settings.json';
    codexLogin = 'apiKey';
    await keys.write('claude-code', 'test-key-not-real');

    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'apiKey', options: {} })).resolves.toBeUndefined();
  });

  it('not on an API key out of credit, naming since when and that it is checked', async () => {
    await keys.write('claude-code', 'test-key-not-real');
    await createKeyStates({ keys: join(home, 'keys'), file: join(home, 'proxy', 'key-states.json') }).record('claude-code', { state: 'outOfCredit', at: new Date('2026-10-28T14:02:00.000Z') });

    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).startProblem({ harness: 'claude-code', login: 'apiKey', options: {} })).resolves.toBe(
      "claude-code's API key is out of credit since 2026-10-28T14:02:00.000Z: it is checked every 15 minutes, or at once with aeolus-trierarch login claude-code --check",
    );
  });

  it('not on an API key its vendor refused, saying to give it a new one', async () => {
    await keys.write('codex', 'test-key-not-real');
    await createKeyStates({ keys: join(home, 'keys'), file: join(home, 'proxy', 'key-states.json') }).record('codex', { state: 'refused', at: new Date('2026-10-28T14:02:00.000Z') });

    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).startProblem({ harness: 'codex', login: 'apiKey', options: {} })).resolves.toBe(
      "codex's API key was refused by its vendor since 2026-10-28T14:02:00.000Z: give it a new one with aeolus-trierarch login codex --api-key",
    );
  });

  it("says each harness's key state", async () => {
    await keys.write('codex', 'test-key-not-real');

    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).keyState('codex')).resolves.toEqual({ state: 'ready' });
    await expect(createModelLogins({ runtime: 'host', ...harnesses() }).keyState('claude-code')).resolves.toEqual({ state: 'none' });
  });
});

