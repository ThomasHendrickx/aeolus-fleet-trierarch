import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ShipId, TrierarchConfiguration } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { CODEX_TYPING_SETTLE_MS, createCodexHarness } from './codex.js';
import { runCommand } from './run-command.js';

// With the aeolus plugin's own scripts from this repository, in a temporary data folder standing for Codex's.

const PLUGIN_ROOT = fileURLToPath(new URL('../../../../plugins/aeolus', import.meta.url));

const WITH_CODEX: TrierarchConfiguration = {
  ...CONFIGURATION,
  harnesses: {
    codex: {
      flags: ['--dangerously-bypass-approvals-and-sandbox'],
      options: { model: { values: { sol: ['-m', 'gpt-5.6-sol'], terra: ['-m', 'gpt-5.6-terra'] }, default: 'sol' } },
    },
  },
};

let data: string;
let folder: string;
let started: { shipId: ShipId; folder: string; command: readonly string[] }[];
let typed: { shipId: ShipId; text: string; settleMs?: number }[];

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'trierarch-codex-plugin-data-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-codex-session-')));
  started = [];
  typed = [];
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

function harness() {
  return createCodexHarness({
    configuration: WITH_CODEX,
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

/** The launch of the ship scout in a worktree of aeolus-fleet. */
const launchOf = (shipId: ShipId) => ({ shipId, shipName: 'scout', folder, harness: 'codex', workspace: { kind: 'worktree', repository: 'aeolus-fleet' } }) as const;

describe('Codex as a harness', () => {
  it("writes the folder's identity through the plugin in Codex's plugin data, saying the trierarch wakes it", async () => {
    await harness().prepareIdentity({ folder, identity });

    const path = (await runCommand('bash', { args: [`${PLUGIN_ROOT}/scripts/aeolus-identity.sh`, 'path'], env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: data } })).stdout.trim();
    expect(path.startsWith(data)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('wakeBy=trierarch\n');
    await expect(harness().crewTokenOf(folder)).resolves.toBe('aeolus_ct_v1_scout');
  });

  it('starts codex with the first prompt on the first start, before the configured flags and the picked option', async () => {
    await harness().launch({ ...launchOf(shipId), options: { model: 'terra' }, isFirstStart: true, firstPrompt: 'Review the open pull requests.' });

    expect(started).toEqual([{ shipId, folder, command: ['codex', 'Review the open pull requests.', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.6-terra'] }]);
  });

  it('starts codex with $aeolus-wake on a first start without a first prompt', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true });

    expect(started[0]?.command.slice(0, 2)).toEqual(['codex', '$aeolus-wake']);
  });

  it("resumes the folder's last conversation on a restart, with $aeolus-wake and never the first prompt again", async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false, firstPrompt: 'Review the open pull requests.' });

    expect(started[0]?.command).toEqual(['codex', 'resume', '--last', '$aeolus-wake', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.6-sol']);
  });

  it("wakes a session by typing $aeolus-wake, closed by a space so the skill picker leaves Enter alone, and settling before Enter so Codex takes no paste", async () => {
    await harness().wake({ shipId, folder });

    expect(typed).toEqual([{ shipId, text: '$aeolus-wake ', settleMs: CODEX_TYPING_SETTLE_MS }]);
  });
});
