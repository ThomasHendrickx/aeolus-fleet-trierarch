import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKeyFiles, type KeyFiles } from './key-files.js';
import { createModelLogins } from './model-logins.js';

let home: string;
let keys: KeyFiles;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-model-logins-'));
  keys = createKeyFiles(join(home, 'keys'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('whether a session can start on its login (api keys K9)', () => {
  it('on the subscription, always', async () => {
    await expect(createModelLogins({ keys, runtime: 'host' }).startProblem({ harness: 'claude-code', login: 'subscription' })).resolves.toBeUndefined();
  });

  it('on an API key, once the harness holds one', async () => {
    await keys.write('claude-code', 'test-key-not-real');

    await expect(createModelLogins({ keys, runtime: 'host' }).startProblem({ harness: 'claude-code', login: 'apiKey' })).resolves.toBeUndefined();
  });

  it('not on an API key the harness does not hold, saying how to give it one', async () => {
    await expect(createModelLogins({ keys, runtime: 'host' }).startProblem({ harness: 'claude-code', login: 'apiKey' })).resolves.toBe('claude-code has no API key on this computer: aeolus-trierarch login claude-code --api-key');
  });

  it('for Codex on an API key once it holds one, as for Claude Code', async () => {
    await keys.write('codex', 'test-key-not-real');

    await expect(createModelLogins({ keys, runtime: 'host' }).startProblem({ harness: 'codex', login: 'apiKey' })).resolves.toBeUndefined();
    await expect(createModelLogins({ keys, runtime: 'host' }).startProblem({ harness: 'claude-code', login: 'apiKey' })).resolves.toBe('claude-code has no API key on this computer: aeolus-trierarch login claude-code --api-key');
  });

  it('not on an API key with the container runtime yet', async () => {
    await keys.write('claude-code', 'test-key-not-real');

    await expect(createModelLogins({ keys, runtime: 'container' }).startProblem({ harness: 'claude-code', login: 'apiKey' })).resolves.toBe('a session on an API key runs on the host runtime only, until containers reach the model proxy');
  });
});
