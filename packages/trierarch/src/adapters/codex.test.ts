import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ShipId, TrierarchConfiguration } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { NO_TERMINAL_QUESTIONS } from '@aeolus-fleet/common';
import { CODEX_ADAPTER_FLAGS, CODEX_TYPING_SETTLE_MS, codexCommandLine, createCodexHarness } from './codex.js';
import { CODEX_SCREENS_CHECKED_ON } from './codex-screen.js';
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
/** Where the identities of Codex sessions live, in a home of the test's own (#658). */
let crews: string;
let folder: string;
let started: { shipId: ShipId; folder: string; command: readonly string[]; env?: Readonly<Record<string, string>> }[];
/** What each ship's session shows, by ship id. */
let screens: Map<ShipId, string>;
let typed: { shipId: ShipId; text: string; settleMs?: number }[];
/** The aeolus plugin's hooks Codex does not trust yet, as a plugin update leaves them (#581). */
let untrustedHooks: Set<string>;
/** The hooks Codex did not trust when each session started. */
let untrustedAtStart: (readonly string[])[];

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'trierarch-codex-plugin-data-'));
  crews = join(mkdtempSync(join(tmpdir(), 'trierarch-codex-home-')), '.aeolus', 'crews', 'codex');
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-codex-session-')));
  started = [];
  typed = [];
  screens = new Map();
  untrustedHooks = new Set(['aeolus@aeolus-fleet:hooks/hooks.json:stop:0:0']);
  untrustedAtStart = [];
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(dirname(dirname(dirname(crews))), { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

function harness() {
  return createCodexHarness({
    configuration: WITH_CODEX,
    plugin: { root: PLUGIN_ROOT, data, crews },
    setup: {
      trustAeolusHooks: () => {
        const trusted = [...untrustedHooks];
        untrustedHooks.clear();
        return Promise.resolve(trusted);
      },
    },
    sessions: {
      start: (session) => {
        started.push(session);
        untrustedAtStart.push([...untrustedHooks]);
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

/** The launch id the trierarch started the session with. */
const LAUNCH_ID = 'launch-1';
/** The launch of the ship scout in a worktree of aeolus-fleet. */
const launchOf = (shipId: ShipId) => ({ shipId, shipName: 'scout', folder, harness: 'codex', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, launchId: LAUNCH_ID }) as const;

describe('Codex as a harness', () => {
  it("writes the folder's identity through the plugin in ~/.aeolus/crews/codex, saying the trierarch wakes it (#658)", async () => {
    await harness().prepareIdentity({ folder, identity });

    const path = (await runCommand('bash', { args: [`${PLUGIN_ROOT}/scripts/aeolus-identity.sh`, 'path'], env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_CREWS: crews } })).stdout.trim();
    expect(path.startsWith(crews)).toBe(true);
    expect(readdirSync(crews)).toContain(basename(path));
    expect(readFileSync(path, 'utf8')).toContain('wakeBy=trierarch\n');
    await expect(harness().crewTokenOf(folder)).resolves.toBe('aeolus_ct_v1_scout');
  });

  it('starts codex with the first prompt on the first start, last and after -- behind the configured flags and the picked option, ending in the line that no human reads its terminal (#585)', async () => {
    await harness().launch({ ...launchOf(shipId), options: { model: 'terra' }, isFirstStart: true, firstPrompt: 'Review the open pull requests.' });

    expect(started).toEqual([{ shipId, folder, command: ['codex', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.6-terra', '--no-daemon', '--config=tools.experimental_request_user_input.enabled=false', '--', `Review the open pull requests.\n\n${NO_TERMINAL_QUESTIONS}`], env: { AEOLUS_LAUNCH: LAUNCH_ID } }]);
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

  it("trusts the aeolus plugin's new or changed hooks before every start, a restart too, so a session after a plugin update never stops at Codex's hooks review (#581)", async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true });
    untrustedHooks.add('aeolus@aeolus-fleet:hooks/hooks.json:user_prompt_submit:0:0');
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false });

    expect(untrustedAtStart).toEqual([[], []]);
  });

  it("starts no session when Codex's hooks cannot be trusted, since it would stop at the hooks review (#581)", async () => {
    const failing = createCodexHarness({
      configuration: WITH_CODEX,
      plugin: { root: PLUGIN_ROOT, data, crews },
      setup: { trustAeolusHooks: () => Promise.reject(new Error('codex app-server did not answer hooks/list')) },
      sessions: {
        start: (session) => {
          started.push(session);
          return Promise.resolve();
        },
        type: () => Promise.resolve(),
        screen: () => Promise.resolve(''),
      },
    });

    await expect(failing.launch({ ...launchOf(shipId), options: {}, isFirstStart: true })).rejects.toThrow('codex app-server did not answer hooks/list');
    expect(started).toEqual([]);
  });

  it('adds --no-daemon once even when the operator configured it too, so the session owns its work and a stop stops it', async () => {
    const withNoDaemon = createCodexHarness({
      configuration: { ...WITH_CODEX, harnesses: { codex: { flags: ['--no-daemon'], options: {} } } },
      plugin: { root: PLUGIN_ROOT, data, crews },
      setup: { trustAeolusHooks: () => Promise.resolve([]) },
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

  // The screen is captured from a real idle Codex 0.162.1 session in tmux after this adapter's wake typed into it (#589).
  it('wakes a real idle Codex: the typed wake is submitted as one prompt, not left in the skill picker, and the session runs the wake skill', async () => {
    await harness().wake({ shipId, folder });
    const woken = readFileSync(new URL('../../test/screens/codex-woken.txt', import.meta.url), 'utf8');
    screens.set(shipId, woken);

    expect(woken).toContain(`› ${typed[0]?.text ?? ''}\n\n• I’m using the aeolus-wake skill`);
  });

  it('names the Codex version its launch screens were checked on, so a launch on another version that shows no activity is told to argo (#594)', () => {
    expect(harness().screensCheckedOn).toBe(CODEX_SCREENS_CHECKED_ON);
  });

});

describe("Codex's launch window, from the launch marker its session's hooks keep (#490)", () => {
  /** Runs the plugin's launch hook as Codex runs it in a session started for the launch given. */
  async function hooked(payload: Record<string, unknown>, launchId = LAUNCH_ID): Promise<void> {
    const marked = await runCommand('bash', {
      args: [`${PLUGIN_ROOT}/scripts/aeolus-launch.sh`],
      env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_CREWS: crews, AEOLUS_LAUNCH: launchId },
      input: JSON.stringify({ cwd: folder, ...payload }),
    });
    expect(marked.status).toBe(0);
  }

  const sessionStarted = { hook_event_name: 'SessionStart', source: 'startup' };
  const aToolCall = { hook_event_name: 'PreToolUse', tool_name: 'shell' };
  const seen = () => harness().launchSeen({ shipId, folder, launchId: LAUNCH_ID, model: 'gpt-5.6-sol' });
  /** Codex's real session logs (test/logs), as its hooks name them in transcript_path. */
  const REFUSED_LOG = fileURLToPath(new URL('../../test/logs/codex-refused.jsonl', import.meta.url));
  const ANSWERED_LOG = fileURLToPath(new URL('../../test/logs/codex-answered.jsonl', import.meta.url));
  const hooksReview = () => readFileSync(new URL('../../test/screens/codex-hooks.txt', import.meta.url), 'utf8');

  beforeEach(async () => {
    await harness().prepareIdentity({ folder, identity });
  });

  it('starts a session with its launch id, the marker of an earlier launch cleared first', async () => {
    await hooked(sessionStarted, 'launch-0');

    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true });

    expect(started.map((each) => each.env)).toEqual([{ AEOLUS_LAUNCH: LAUNCH_ID }]);
    const marker = await runCommand('bash', { args: [`${PLUGIN_ROOT}/scripts/aeolus-identity.sh`, 'launch'], env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_CREWS: crews } });
    expect(marker.status).toBe(1);
  });

  it('sees activity once the hooks marked a tool call of its launch', async () => {
    await hooked(sessionStarted);
    await hooked(aToolCall);

    await expect(seen()).resolves.toEqual({ kind: 'active' });
  });

  it('sees the model it launched with refused in the session log its hooks named, as Codex has no hook for a failed turn', async () => {
    await hooked({ ...sessionStarted, transcript_path: REFUSED_LOG });

    await expect(harness().launchSeen({ shipId, folder, launchId: LAUNCH_ID, model: 'gpt-nonexistent-9' })).resolves.toEqual({ kind: 'refused', model: 'gpt-nonexistent-9' });
  });

  it('reads no refusal from its screen, only from its session log', async () => {
    screens.set(shipId, readFileSync(new URL('../../test/screens/codex-refused.txt', import.meta.url), 'utf8'));
    await hooked({ ...sessionStarted, transcript_path: ANSWERED_LOG });

    await expect(harness().launchSeen({ shipId, folder, launchId: LAUNCH_ID, model: 'gpt-nonexistent-9' })).resolves.toEqual({ kind: 'none' });
  });

  it('sees no refusal when the session log its hooks named is gone', async () => {
    await hooked({ ...sessionStarted, transcript_path: join(folder, 'gone.jsonl') });

    await expect(harness().launchSeen({ shipId, folder, launchId: LAUNCH_ID, model: 'gpt-nonexistent-9' })).resolves.toEqual({ kind: 'none' });
  });

  it('names no screen once its session started', async () => {
    screens.set(shipId, hooksReview());
    await hooked(sessionStarted);

    await expect(seen()).resolves.toEqual({ kind: 'none' });
  });

  it('names the screen its session stopped at when it never started', async () => {
    screens.set(shipId, hooksReview());

    await expect(seen()).resolves.toEqual({ kind: 'none', screen: 'hooks review' });
  });

  it('counts nothing the hooks marked for another launch', async () => {
    await hooked(sessionStarted, 'launch-0');
    await hooked(aToolCall, 'launch-0');

    await expect(seen()).resolves.toEqual({ kind: 'none' });
  });

  it('says its aeolus plugin marks launches', async () => {
    await expect(harness().marksLaunches()).resolves.toBe(true);
  });
});
