import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { createClaudeCodeHarness } from './claude-code.js';
import { runCommand } from './run-command.js';

// With the aeolus plugin's own scripts from this repository, in a temporary data folder.

const PLUGIN_ROOT = fileURLToPath(new URL('../../../../plugins/aeolus', import.meta.url));

let data: string;
let folder: string;
let started: { shipId: ShipId; folder: string; command: readonly string[] }[];
let typed: { shipId: ShipId; text: string }[];

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'trierarch-plugin-data-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-session-')));
  started = [];
  typed = [];
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

function harness() {
  return createClaudeCodeHarness({
    configuration: CONFIGURATION,
    plugin: { root: PLUGIN_ROOT, data },
    sessions: {
      start: (session) => {
        started.push(session);
        return Promise.resolve();
      },
      type: (at) => {
        typed.push(at);
        return Promise.resolve();
      },
    },
  });
}

const shipId = newId('ship');
const identity = { fleetUrl: 'https://fleet.example.com', shipId, shipName: 'scout', crewToken: 'aeolus_ct_v1_scout' };

describe('Claude Code as a harness', () => {
  it("writes the folder's identity through the plugin, saying the trierarch wakes it, with the squadron", async () => {
    await harness().prepareIdentity({ folder, identity: { ...identity, squadron: 'hemma-feature-a1b2c3' } });

    const path = (await runCommand('bash', { args: [`${PLUGIN_ROOT}/scripts/aeolus-identity.sh`, 'path'], env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: data } })).stdout.trim();
    const written = readFileSync(path, 'utf8');
    expect(written).toContain(`shipId=${shipId}\n`);
    expect(written).toContain('squadron=hemma-feature-a1b2c3\n');
    expect(written).toContain('wakeBy=trierarch\n');
  });

  it("reads the crew token from the folder's identity, and none once it is removed", async () => {
    await harness().prepareIdentity({ folder, identity });
    await expect(harness().crewTokenOf(folder)).resolves.toBe('aeolus_ct_v1_scout');

    await harness().removeIdentity(folder);

    await expect(harness().crewTokenOf(folder)).resolves.toBeUndefined();
  });

  it('starts claude with the first prompt on the first start, before the configured flags so a flag with an optional value never takes it', async () => {
    await harness().launch({ shipId, folder, harness: 'claude-code', options: { model: 'sonnet' }, isFirstStart: true, firstPrompt: 'Review the open pull requests.' });

    expect(started).toEqual([{ shipId, folder, command: ['claude', 'Review the open pull requests.', '--remote-control', '--model', 'claude-sonnet-5-5'] }]);
  });

  it('starts claude with /aeolus:wake on a first start without a first prompt', async () => {
    await harness().launch({ shipId, folder, harness: 'claude-code', options: {}, isFirstStart: true });

    expect(started[0]?.command[1]).toBe('/aeolus:wake');
  });

  it('continues the conversation on a restart, with /aeolus:wake and never the first prompt again', async () => {
    await harness().launch({ shipId, folder, harness: 'claude-code', options: {}, isFirstStart: false, firstPrompt: 'Review the open pull requests.' });

    expect(started[0]?.command).toEqual(['claude', '/aeolus:wake', '--remote-control', '--model', 'claude-opus-5-5', '--continue']);
  });

  it('wakes a session by typing /aeolus:wake', async () => {
    await harness().wake({ shipId, folder });

    expect(typed).toEqual([{ shipId, text: '/aeolus:wake' }]);
  });

  it("reads the turn from the plugin's turn marker: unknown before the first prompt, then busy or idle", async () => {
    await harness().prepareIdentity({ folder, identity });
    await expect(harness().turnOf(folder)).resolves.toBe('unknown');

    const marked = await runCommand('bash', {
      args: [`${PLUGIN_ROOT}/scripts/aeolus-turn.sh`],
      env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: data },
      input: JSON.stringify({ cwd: folder, hook_event_name: 'UserPromptSubmit' }),
    });

    expect(marked.status).toBe(0);
    await expect(harness().turnOf(folder)).resolves.toBe('busy');
  });
});
