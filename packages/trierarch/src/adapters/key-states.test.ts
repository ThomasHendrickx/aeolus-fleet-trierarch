import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKeyFiles, type KeyFiles } from './key-files.js';
import { createKeyStates } from './key-states.js';

const AT = new Date('2026-10-28T14:02:00.000Z');

let home: string;
let keys: KeyFiles;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-key-states-'));
  keys = createKeyFiles(join(home, 'keys'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const states = () => createKeyStates({ keys: join(home, 'keys'), file: join(home, 'proxy', 'key-states.json') });

describe("a harness's key state (api keys K8)", () => {
  it('is none without a key', async () => {
    await expect(states().stateOf('claude-code')).resolves.toEqual({ state: 'none' });
  });

  it('is ready for a key nothing was said of', async () => {
    await keys.write('claude-code', 'test-key-not-real');

    await expect(states().stateOf('claude-code')).resolves.toEqual({ state: 'ready' });
  });

  it('is what was recorded of the key, since when it was recorded', async () => {
    await keys.write('claude-code', 'test-key-not-real');

    await states().record('claude-code', { state: 'outOfCredit', at: AT });

    await expect(states().stateOf('claude-code')).resolves.toEqual({ state: 'outOfCredit', at: AT.toISOString() });
    await expect(states().stateOf('codex')).resolves.toEqual({ state: 'none' });
  });

  it('keeps when it was first recorded while it stays the same', async () => {
    await keys.write('codex', 'test-key-not-real');
    await states().record('codex', { state: 'refused', at: AT });

    await states().record('codex', { state: 'refused', at: new Date(AT.getTime() + 60_000) });

    await expect(states().stateOf('codex')).resolves.toEqual({ state: 'refused', at: AT.toISOString() });
  });

  it('is ready again for a new key, whatever was recorded of the one before (api keys K10)', async () => {
    await keys.write('claude-code', 'test-key-old');
    await states().record('claude-code', { state: 'refused', at: AT });

    await keys.write('claude-code', 'test-key-new');

    await expect(states().stateOf('claude-code')).resolves.toEqual({ state: 'ready' });
  });

  it('is ready once the key works again', async () => {
    await keys.write('claude-code', 'test-key-not-real');
    await states().record('claude-code', { state: 'outOfCredit', at: AT });

    await states().record('claude-code', { state: 'ready', at: AT });

    await expect(states().stateOf('claude-code')).resolves.toEqual({ state: 'ready' });
  });
});
