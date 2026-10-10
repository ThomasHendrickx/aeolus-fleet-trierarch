import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ShipId, TrierarchConfiguration } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { NO_TERMINAL_QUESTIONS } from '@aeolus-fleet/common';
import { CODEX_ADAPTER_FLAGS, CODEX_TYPING_SETTLE_MS, codexCommandLine, createCodexHarness } from './codex.js';
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
/** What each ship's session shows, by ship id. */
let screens: Map<ShipId, string>;
let typed: { shipId: ShipId; text: string; settleMs?: number }[];

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'trierarch-codex-plugin-data-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-codex-session-')));
  started = [];
  typed = [];
  screens = new Map();
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
      screen: (shipId) => Promise.resolve(screens.get(shipId) ?? ''),
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

  it('starts codex with the first prompt on the first start, last and after -- behind the configured flags and the picked option, ending in the line that no human reads its terminal (#585)', async () => {
    await harness().launch({ ...launchOf(shipId), options: { model: 'terra' }, isFirstStart: true, firstPrompt: 'Review the open pull requests.' });

    expect(started).toEqual([{ shipId, folder, command: ['codex', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.6-terra', '--no-daemon', '--config=tools.experimental_request_user_input.enabled=false', '--', `Review the open pull requests.\n\n${NO_TERMINAL_QUESTIONS}`] }]);
  });

  it('passes a first prompt that starts with - after --, so it never reads as a flag', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true, firstPrompt: '--dangerously-bypass-approvals-and-sandbox' });

    expect(started[0]?.command.slice(-2)).toEqual(['--', `--dangerously-bypass-approvals-and-sandbox\n\n${NO_TERMINAL_QUESTIONS}`]);
  });

  it('starts codex with $aeolus-wake on a first start without a first prompt, the line that no human reads its terminal after it (#585)', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true });

    expect(started[0]?.command.slice(-2)).toEqual(['--', `$aeolus-wake ${NO_TERMINAL_QUESTIONS}`]);
  });

  it("resumes the folder's last conversation on a restart, with $aeolus-wake and the line that no human reads its terminal, never the first prompt again (#585)", async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false, firstPrompt: 'Review the open pull requests.' });

    expect(started[0]?.command).toEqual(['codex', 'resume', '--last', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.6-sol', '--no-daemon', '--config=tools.experimental_request_user_input.enabled=false', '--', `$aeolus-wake ${NO_TERMINAL_QUESTIONS}`]);
  });

  it('adds --no-daemon once even when the operator configured it too, so the session owns its work and a stop stops it', async () => {
    const withNoDaemon = createCodexHarness({
      configuration: { ...WITH_CODEX, harnesses: { codex: { flags: ['--no-daemon'], options: {} } } },
      plugin: { root: PLUGIN_ROOT, data },
      sessions: {
        start: (session) => {
          started.push(session);
          return Promise.resolve();
        },
        type: () => Promise.resolve(),
        screen: () => Promise.resolve(''),
      },
    });

    await withNoDaemon.launch({ ...launchOf(shipId), options: {}, isFirstStart: true });

    expect(started[0]?.command.filter((part) => part === '--no-daemon')).toHaveLength(1);
  });

  it('starts codex without its question tool on every start, so the crewed session asks over the fleet and never waits on a question in a pane nobody watches (#460)', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true, firstPrompt: 'Review the open pull requests.' });
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false });

    expect(started.map((session) => session.command.filter((word) => word.includes('request_user_input')))).toEqual([['--config=tools.experimental_request_user_input.enabled=false'], ['--config=tools.experimental_request_user_input.enabled=false']]);
  });

  it('tells the configured flags from --no-daemon and the question tool switched off, which the adapter adds to every launch', () => {
    expect(CODEX_ADAPTER_FLAGS).toEqual([
      { flag: '--no-daemon', when: 'always' },
      { flag: '--config=tools.experimental_request_user_input.enabled=false', when: 'always' },
    ]);
    expect(codexCommandLine({ flags: ['--dangerously-bypass-approvals-and-sandbox', '--no-daemon'], prompt: '<first prompt>', isFirstStart: true })).toEqual([
      { words: ['codex'] },
      { words: ['--dangerously-bypass-approvals-and-sandbox'], source: 'configuration' },
      { words: ['--no-daemon'], source: 'adapter' },
      { words: ['--config=tools.experimental_request_user_input.enabled=false'], source: 'adapter' },
      { words: ['--', '<first prompt>'] },
    ]);
    expect(codexCommandLine({ flags: [], prompt: '$aeolus-wake', isFirstStart: false })).toEqual([
      { words: ['codex', 'resume', '--last'] },
      { words: ['--no-daemon'], source: 'adapter' },
      { words: ['--config=tools.experimental_request_user_input.enabled=false'], source: 'adapter' },
      { words: ['--', '$aeolus-wake'] },
    ]);
  });

  it('wakes a session by typing $aeolus-wake and the line that no human reads its terminal, the space after the skill closing its picker so it leaves Enter alone, and settling before Enter so Codex takes no paste (#585)', async () => {
    await harness().wake({ shipId, folder });

    expect(typed).toEqual([{ shipId, text: `$aeolus-wake ${NO_TERMINAL_QUESTIONS}`, settleMs: CODEX_TYPING_SETTLE_MS }]);
  });

  it("sees in its session's screen the model it launched with refused", async () => {
    screens.set(shipId, readFileSync(new URL('../../test/screens/codex-refused.txt', import.meta.url), 'utf8'));

    await expect(harness().launchSeen({ shipId, model: 'gpt-nonexistent-9' })).resolves.toEqual({ kind: 'refused', model: 'gpt-nonexistent-9' });
  });
});
