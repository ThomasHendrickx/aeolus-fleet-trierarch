import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { CLAUDE_CODE_ADAPTER_FLAGS, claudeCodeCommandLine, createClaudeCodeHarness } from './claude-code.js';
import { createClaudeCodeSetup } from './claude-code-setup.js';
import { runCommand } from './run-command.js';

// With the aeolus plugin's own scripts from this repository, in a temporary data folder.

const PLUGIN_ROOT = fileURLToPath(new URL('../../../../plugins/aeolus', import.meta.url));

let data: string;
let folder: string;
/** Claude Code's projects folder, where it keeps each folder's conversations. */
let projects: string;
let started: { shipId: ShipId; folder: string; command: readonly string[] }[];
/** What each ship's session shows, by ship id. */
let screens: Map<ShipId, string>;
let typed: { shipId: ShipId; text: string }[];
/** A home folder of its own, so no test touches Claude Code's own files on this machine. */
let home: string;
/** What ~/.claude.json held as each session started, or undefined when there was none. */
let claudeJsonAtStart: (string | undefined)[];

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'trierarch-plugin-data-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-session-')));
  projects = mkdtempSync(join(tmpdir(), 'trierarch-claude-projects-'));
  started = [];
  typed = [];
  screens = new Map();
  home = mkdtempSync(join(tmpdir(), 'trierarch-home-'));
  claudeJsonAtStart = [];
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A conversation Claude Code kept for the folder, where it keeps them: under the folder's path with every other character than a letter or digit as `-`. */
function aConversationIn(folder: string): void {
  const kept = join(projects, folder.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(kept, { recursive: true });
  writeFileSync(join(kept, '0b8e3f2a-5c1d-4e7f-9a6b-2d4c8e1f3a5b.jsonl'), '{}\n');
}

function harness() {
  return createClaudeCodeHarness({
    configuration: CONFIGURATION,
    plugin: { root: PLUGIN_ROOT, data },
    projects,
    setup: createClaudeCodeSetup({ homeDirectory: home }),
    sessions: {
      start: (session) => {
        started.push(session);
        const claudeJson = join(home, '.claude.json');
        claudeJsonAtStart.push(existsSync(claudeJson) ? readFileSync(claudeJson, 'utf8') : undefined);
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

const parsed = (text: string | undefined): unknown => (text === undefined ? undefined : JSON.parse(text));

/** The launch of the ship scout in a worktree of aeolus-fleet. */
const launchOf = (shipId: ShipId) => ({ shipId, shipName: 'scout', folder, harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' } }) as const;

describe('Claude Code as a harness', () => {
  it("completes Claude Code's onboarding before it starts a session, so a fresh machine shows no first-run screen (#403)", async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true });

    expect(claudeJsonAtStart.map(parsed)).toEqual([{ hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 3 }]);
  });

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

  it('starts claude with the first prompt on the first start, last and after -- so no flag takes it', async () => {
    await harness().launch({ ...launchOf(shipId), options: { model: 'sonnet' }, isFirstStart: true, firstPrompt: 'Review the open pull requests.' });

    expect(started).toEqual([{ shipId, folder, command: ['claude', '--remote-control', '[aeolus-fleet] scout', '--model', 'claude-sonnet-5-5', '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', '--', 'Review the open pull requests.'] }]);
  });

  it('starts claude without AskUserQuestion and without plan mode on every start, so the crewed session asks over the fleet and never waits on a question form or a plan approval in a pane nobody watches (#457, #460)', async () => {
    aConversationIn(folder);

    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true, firstPrompt: 'Review the open pull requests.' });
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false });

    expect(started.map((session) => session.command.filter((word) => word.startsWith('--disallowedTools')))).toEqual([['--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode'], ['--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode']]);
  });

  it('passes a first prompt that starts with - after --, so it never reads as a flag', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true, firstPrompt: '--dangerously-skip-permissions' });

    expect(started[0]?.command.slice(-2)).toEqual(['--', '--dangerously-skip-permissions']);
  });

  it('starts claude with /aeolus:wake on a first start without a first prompt', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true });

    expect(started[0]?.command.slice(-2)).toEqual(['--', '/aeolus:wake']);
  });

  it('continues the conversation on a restart, with /aeolus:wake and never the first prompt again', async () => {
    aConversationIn(folder);

    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false, firstPrompt: 'Review the open pull requests.' });

    expect(started[0]?.command).toEqual(['claude', '--remote-control', '[aeolus-fleet] scout', '--model', 'claude-opus-5-5', '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', '--continue', '--', '/aeolus:wake']);
  });

  it('starts fresh on a restart when the folder has no conversation to continue, as claude --continue would exit at once (#381)', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false });

    expect(started[0]?.command).toEqual(['claude', '--remote-control', '[aeolus-fleet] scout', '--model', 'claude-opus-5-5', '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', '--', '/aeolus:wake']);
  });

  it('continues on a restart only a conversation of its own folder, not one of another folder (#381)', async () => {
    aConversationIn(join(folder, 'elsewhere'));

    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false });

    expect(started[0]?.command).not.toContain('--continue');
  });

  it('names the remote-control session after its folder and ship: the repository of a worktree, the name of a configured folder', async () => {
    await harness().launch({ ...launchOf(shipId), workspace: { kind: 'folder', name: 'notes' }, options: {}, isFirstStart: true });

    expect(started[0]?.command.slice(1, 3)).toEqual(['--remote-control', '[notes] scout']);
  });

  it('keeps a remote-control name the operator configured, and names nothing without --remote-control', async () => {
    const withFlags = (flags: string[]) =>
      createClaudeCodeHarness({
        configuration: { ...CONFIGURATION, harnesses: { 'claude-code': { flags, options: {} } } },
        plugin: { root: PLUGIN_ROOT, data },
        projects,
        setup: createClaudeCodeSetup({ homeDirectory: home }),
        sessions: {
          start: (session) => {
            started.push(session);
            return Promise.resolve();
          },
          type: () => Promise.resolve(),
          screen: () => Promise.resolve(''),
        },
      });

    await withFlags(['--remote-control', 'mine', '--verbose']).launch({ ...launchOf(shipId), options: {}, isFirstStart: true });
    await withFlags(['--verbose']).launch({ ...launchOf(shipId), options: {}, isFirstStart: true });

    expect(started.map((session) => session.command.slice(1, -3))).toEqual([['--remote-control', 'mine', '--verbose'], ['--verbose']]);
  });

  it('tells the configured flags from the remote-control name and --continue on a restart, which the adapter adds', () => {
    expect(CLAUDE_CODE_ADAPTER_FLAGS).toEqual([
      { flag: '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', when: 'always' },
      { flag: '--continue', when: 'restart' },
    ]);
    expect(claudeCodeCommandLine({ flags: ['--remote-control', '--model', 'claude-opus-5-5'], sessionName: '[aeolus-fleet] scout', prompt: '/aeolus:wake', isFirstStart: false })).toEqual([
      { words: ['claude'] },
      { words: ['--remote-control'], source: 'configuration' },
      { words: ['[aeolus-fleet] scout'], source: 'adapter' },
      { words: ['--model', 'claude-opus-5-5'], source: 'configuration' },
      { words: ['--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode'], source: 'adapter' },
      { words: ['--continue'], source: 'adapter' },
      { words: ['--', '/aeolus:wake'] },
    ]);
    expect(claudeCodeCommandLine({ flags: ['--verbose'], sessionName: '[aeolus-fleet] scout', prompt: '<first prompt>', isFirstStart: true })).toEqual([
      { words: ['claude'] },
      { words: ['--verbose'], source: 'configuration' },
      { words: ['--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode'], source: 'adapter' },
      { words: ['--', '<first prompt>'] },
    ]);
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

  it("sees in its session's screen the model it launched with refused", async () => {
    screens.set(shipId, readFileSync(new URL('../../test/screens/claude-code-refused.txt', import.meta.url), 'utf8'));

    await expect(harness().launchSeen({ shipId, model: 'claude-nonexistent-9' })).resolves.toEqual({ kind: 'refused', model: 'claude-nonexistent-9' });
  });
});
