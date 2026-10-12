import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { effectiveFlags } from '../core/effective-flags.js';
import { NO_TERMINAL_QUESTIONS } from '@aeolus-fleet/common';
import { CLAUDE_CODE_ADAPTER_FLAGS, claudeCodeCommandLine, createClaudeCodeHarness } from './claude-code.js';
import { createClaudeCodeSetup } from './claude-code-setup.js';
import { wordsOf } from './command-line.js';
import { runCommand } from './run-command.js';

// With the aeolus plugin's own scripts from this repository, in a temporary data folder and home.

const PLUGIN_ROOT = fileURLToPath(new URL('../../../../plugins/aeolus', import.meta.url));

let data: string;
/** Where the identities of Claude Code sessions live in the test's home (#658). */
let crews: string;
let folder: string;
/** Claude Code's projects folder, where it keeps each folder's conversations. */
let projects: string;
let started: { shipId: ShipId; folder: string; command: readonly string[]; env?: Readonly<Record<string, string>> }[];
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
  crews = join(home, '.aeolus', 'crews', 'claude-code');
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

function harness(at: { pluginRoot?: string } = {}) {
  return createClaudeCodeHarness({
    configuration: CONFIGURATION,
    plugin: { root: at.pluginRoot ?? PLUGIN_ROOT, data, crews },
    projects,
    setup: createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }),
    permissionModes: () => undefined,
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

/** The launch id the trierarch started the session with. */
const LAUNCH_ID = 'launch-1';
/** The launch of the ship scout in a worktree of aeolus-fleet. */
const launchOf = (shipId: ShipId) => ({ shipId, shipName: 'scout', folder, harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, launchId: LAUNCH_ID }) as const;

describe('Claude Code as a harness', () => {
  it("completes Claude Code's onboarding before it starts a session, so a fresh machine shows no first-run screen (#403)", async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true });

    expect(claudeJsonAtStart.map(parsed)).toEqual([{ hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 3 }]);
  });

  it("writes the folder's identity through the plugin, saying the trierarch wakes it, with the squadron", async () => {
    await harness().prepareIdentity({ folder, identity: { ...identity, squadron: 'hemma-feature-a1b2c3' } });

    const path = (await runCommand('bash', { args: [`${PLUGIN_ROOT}/scripts/aeolus-identity.sh`, 'path'], env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_CREWS: crews } })).stdout.trim();
    const written = readFileSync(path, 'utf8');
    expect(written).toContain(`shipId=${shipId}\n`);
    expect(written).toContain('squadron=hemma-feature-a1b2c3\n');
    expect(written).toContain('wakeBy=trierarch\n');
  });

  it("writes the folder's identity in ~/.aeolus/crews/claude-code, outside the plugin's data folder (#658)", async () => {
    await harness().prepareIdentity({ folder, identity });

    expect(readFileSync(join(crews, `${createHash('sha256').update(folder).digest('hex').slice(0, 32)}.identity`), 'utf8')).toContain('crewToken=aeolus_ct_v1_scout\n');
  });

  it("reads the crew token of a folder crewed by a plugin from before #658, its identity still in the plugin's data folder", async () => {
    mkdirSync(join(data, 'ships'));
    writeFileSync(join(data, 'ships', `${createHash('sha256').update(folder).digest('hex').slice(0, 32)}.identity`), `shipId=${shipId}\ncrewToken=aeolus_ct_v1_scout\n`);

    await expect(harness().crewTokenOf(folder)).resolves.toBe('aeolus_ct_v1_scout');
  });

  it("reads the crew token from the folder's identity, and none once it is removed", async () => {
    await harness().prepareIdentity({ folder, identity });
    await expect(harness().crewTokenOf(folder)).resolves.toBe('aeolus_ct_v1_scout');

    await harness().removeIdentity(folder);

    await expect(harness().crewTokenOf(folder)).resolves.toBeUndefined();
  });

  it('starts claude with the first prompt on the first start, last and after -- so no flag takes it, ending in the line that no human reads its terminal (#585)', async () => {
    await harness().launch({ ...launchOf(shipId), options: { model: 'sonnet' }, isFirstStart: true, firstPrompt: 'Review the open pull requests.' });

    expect(started).toEqual([{ shipId, folder, command: ['claude', '--remote-control', '[aeolus-fleet] scout', '--model', 'claude-sonnet-5-5', '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', '--', `Review the open pull requests.\n\n${NO_TERMINAL_QUESTIONS}`] }]);
  });

  it('starts claude without AskUserQuestion and without plan mode on every start, so the crewed session asks over the fleet and never waits on a question form or a plan approval in a pane nobody watches (#457, #460)', async () => {
    aConversationIn(folder);

    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true, firstPrompt: 'Review the open pull requests.' });
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false });

    expect(started.map((session) => session.command.filter((word) => word.startsWith('--disallowedTools')))).toEqual([['--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode'], ['--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode']]);
  });

  it('never starts a crewed session in plan mode, which it could not leave without plan mode: --permission-mode plan from the flags or an option is ignored, another permission mode kept (#465)', () => {
    const wordsFor = (flags: string[]) => wordsOf(claudeCodeCommandLine({ flags, sessionName: '[aeolus-fleet] scout', prompt: '/aeolus:wake', isFirstStart: true }));
    const mode = (flags: string[]) => effectiveFlags({ flags, options: { mode: { values: { plan: ['--permission-mode', 'plan'], edits: ['--permission-mode', 'acceptEdits'] } } } }, { mode: 'plan' });

    expect(wordsFor(['--permission-mode', 'plan', '--verbose'])).toEqual(['claude', '--verbose', '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', '--', '/aeolus:wake']);
    expect(wordsFor(['--permission-mode=plan'])).toEqual(['claude', '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', '--', '/aeolus:wake']);
    expect(wordsFor(mode(['--remote-control']))).toEqual(['claude', '--remote-control', '[aeolus-fleet] scout', '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', '--', '/aeolus:wake']);
    expect(wordsFor(['--permission-mode', 'acceptEdits'])).toEqual(['claude', '--permission-mode', 'acceptEdits', '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', '--', '/aeolus:wake']);
  });

  it("never starts a crewed session in plan mode when Claude Code's settings make plan its default mode: the user's, the project's or the project's local settings, the nearest one winning; a permission mode in the flags is kept (#505)", async () => {
    const defaultModeIn = (settings: string, defaultMode: string) => {
      mkdirSync(dirname(settings), { recursive: true });
      writeFileSync(settings, JSON.stringify({ permissions: { defaultMode } }));
    };
    const user = join(home, '.claude', 'settings.json');
    const project = join(folder, '.claude', 'settings.json');
    const projectLocal = join(folder, '.claude', 'settings.local.json');
    const modeOf = async (flags: string[]) => {
      started = [];
      await createClaudeCodeHarness({
        configuration: { ...CONFIGURATION, harnesses: { 'claude-code': { flags, options: {} } } },
        plugin: { root: PLUGIN_ROOT, data, crews },
        projects,
        setup: createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }),
        permissionModes: () => undefined,
        sessions: {
          start: (session) => {
            started.push(session);
            return Promise.resolve();
          },
          type: () => Promise.resolve(),
          screen: () => Promise.resolve(''),
        },
      }).launch({ ...launchOf(shipId), options: {}, isFirstStart: true });
      return started[0]?.command.slice(1, -3);
    };

    expect(await modeOf([])).toEqual([]);
    defaultModeIn(user, 'plan');
    expect(await modeOf([])).toEqual(['--permission-mode', 'default']);
    expect(await modeOf(['--permission-mode', 'acceptEdits'])).toEqual(['--permission-mode', 'acceptEdits']);
    expect(await modeOf(['--dangerously-skip-permissions'])).toEqual(['--dangerously-skip-permissions']);
    defaultModeIn(project, 'acceptEdits');
    expect(await modeOf([])).toEqual([]);
    defaultModeIn(projectLocal, 'plan');
    expect(await modeOf([])).toEqual(['--permission-mode', 'default']);
    rmSync(projectLocal);
    defaultModeIn(project, 'plan');
    expect(await modeOf(['--permission-mode', 'plan'])).toEqual(['--permission-mode', 'default']);
  });

  describe("never starts a crewed session in plan mode from any of Claude Code's settings sources, the one Claude Code takes winning (#507)", () => {
    let managed: string;
    let configDirectory: string;

    beforeEach(() => {
      managed = mkdtempSync(join(tmpdir(), 'trierarch-claude-managed-'));
      configDirectory = mkdtempSync(join(tmpdir(), 'trierarch-claude-config-'));
    });

    afterEach(() => {
      rmSync(managed, { recursive: true, force: true });
      rmSync(configDirectory, { recursive: true, force: true });
    });

    const defaultModeIn = (settings: string, defaultMode: string) => {
      mkdirSync(dirname(settings), { recursive: true });
      writeFileSync(settings, JSON.stringify({ permissions: { defaultMode } }));
    };
    /** The words between claude and the adapter's own flags: the configured flags and the override, if any. */
    const modeOf = async (flags: string[], at: { configDirectory?: string; permissionModes?: readonly string[] } = {}) => {
      started = [];
      await createClaudeCodeHarness({
        configuration: { ...CONFIGURATION, harnesses: { 'claude-code': { flags, options: {} } } },
        plugin: { root: PLUGIN_ROOT, data, crews },
        projects,
        setup: createClaudeCodeSetup({ homeDirectory: home, managedSettings: managed, ...(at.configDirectory !== undefined && { configDirectory: at.configDirectory }) }),
        permissionModes: () => at.permissionModes,
        sessions: {
          start: (session) => {
            started.push(session);
            return Promise.resolve();
          },
          type: () => Promise.resolve(),
          screen: () => Promise.resolve(''),
        },
      }).launch({ ...launchOf(shipId), options: {}, isFirstStart: true });
      return started[0]?.command.slice(1, -3);
    };

    it("overrides a plan default mode in the managed settings, which win over the folder's", async () => {
      defaultModeIn(join(folder, '.claude', 'settings.local.json'), 'acceptEdits');
      defaultModeIn(join(managed, 'managed-settings.json'), 'plan');

      expect(await modeOf([])).toEqual(['--permission-mode', 'default']);
    });

    it('names the mode the installed Claude Code documents, as detection last found its permission modes: manual where they list it (#517)', async () => {
      defaultModeIn(join(managed, 'managed-settings.json'), 'plan');

      expect(await modeOf([], { permissionModes: ['acceptEdits', 'manual', 'plan'] })).toEqual(['--permission-mode', 'manual']);
    });

    it('takes the managed drop-ins after managed-settings.json, in alphabetical order, the last one winning', async () => {
      defaultModeIn(join(folder, '.claude', 'settings.json'), 'plan');
      defaultModeIn(join(managed, 'managed-settings.json'), 'plan');
      defaultModeIn(join(managed, 'managed-settings.d', '20-edits.json'), 'acceptEdits');
      defaultModeIn(join(managed, 'managed-settings.d', '10-plan.json'), 'plan');
      expect(await modeOf([])).toEqual([]);

      defaultModeIn(join(managed, 'managed-settings.d', '30-plan.json'), 'plan');
      expect(await modeOf([])).toEqual(['--permission-mode', 'default']);
    });

    it("overrides a plan default mode given with --settings as JSON or as a file, relative to the folder, which wins over the folder's settings", async () => {
      defaultModeIn(join(folder, '.claude', 'settings.local.json'), 'acceptEdits');
      defaultModeIn(join(folder, 'crew-settings.json'), 'plan');
      const inline = JSON.stringify({ permissions: { defaultMode: 'plan' } });

      expect(await modeOf(['--settings', inline])).toEqual(['--settings', inline, '--permission-mode', 'default']);
      expect(await modeOf([`--settings=${inline}`])).toEqual([`--settings=${inline}`, '--permission-mode', 'default']);
      expect(await modeOf(['--settings', 'crew-settings.json'])).toEqual(['--settings', 'crew-settings.json', '--permission-mode', 'default']);
    });

    it('keeps a default mode the managed settings give over a plan in --settings', async () => {
      defaultModeIn(join(managed, 'managed-settings.json'), 'acceptEdits');
      const inline = JSON.stringify({ permissions: { defaultMode: 'plan' } });

      expect(await modeOf(['--settings', inline])).toEqual(['--settings', inline]);
    });

    it("reads the user's settings from CLAUDE_CONFIG_DIR when it is set, as Claude Code does", async () => {
      defaultModeIn(join(configDirectory, 'settings.json'), 'plan');
      defaultModeIn(join(home, '.claude', 'settings.json'), 'acceptEdits');

      expect(await modeOf([], { configDirectory })).toEqual(['--permission-mode', 'default']);
    });

    it('leaves out the settings sources Claude Code does not load: those --setting-sources leaves out, and the user, project and local settings with --restricted', async () => {
      defaultModeIn(join(folder, '.claude', 'settings.json'), 'acceptEdits');
      defaultModeIn(join(home, '.claude', 'settings.json'), 'plan');
      expect(await modeOf(['--setting-sources', 'user'])).toEqual(['--setting-sources', 'user', '--permission-mode', 'default']);
      expect(await modeOf(['--setting-sources=user,local'])).toEqual(['--setting-sources=user,local', '--permission-mode', 'default']);
      expect(await modeOf(['--setting-sources', 'user,project'])).toEqual(['--setting-sources', 'user,project']);

      defaultModeIn(join(home, '.claude', 'settings.json'), 'acceptEdits');
      defaultModeIn(join(folder, '.claude', 'settings.json'), 'plan');
      expect(await modeOf(['--restricted'])).toEqual(['--restricted']);
    });
  });

  it('passes a first prompt that starts with - after --, so it never reads as a flag', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true, firstPrompt: '--dangerously-skip-permissions' });

    expect(started[0]?.command.slice(-2)).toEqual(['--', `--dangerously-skip-permissions\n\n${NO_TERMINAL_QUESTIONS}`]);
  });

  it('starts claude with /aeolus:wake on a first start without a first prompt, the line that no human reads its terminal as its argument (#585)', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true });

    expect(started[0]?.command.slice(-2)).toEqual(['--', `/aeolus:wake ${NO_TERMINAL_QUESTIONS}`]);
  });

  it('continues the conversation on a restart, with /aeolus:wake and the line that no human reads its terminal, never the first prompt again (#585)', async () => {
    aConversationIn(folder);

    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false, firstPrompt: 'Review the open pull requests.' });

    expect(started[0]?.command).toEqual(['claude', '--remote-control', '[aeolus-fleet] scout', '--model', 'claude-opus-5-5', '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', '--continue', '--', `/aeolus:wake ${NO_TERMINAL_QUESTIONS}`]);
  });

  it('starts fresh on a restart when the folder has no conversation to continue, as claude --continue would exit at once (#381)', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false });

    expect(started[0]?.command).toEqual(['claude', '--remote-control', '[aeolus-fleet] scout', '--model', 'claude-opus-5-5', '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', '--', `/aeolus:wake ${NO_TERMINAL_QUESTIONS}`]);
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
        plugin: { root: PLUGIN_ROOT, data, crews },
        projects,
        setup: createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }),
        permissionModes: () => undefined,
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

  it('overrides a plan default mode with the mode the installed Claude Code documents: manual where its --help lists it, default where it lists modes without manual or none (#517)', () => {
    const overrideWith = (permissionModes?: readonly string[]) =>
      wordsOf(
        claudeCodeCommandLine({
          flags: [],
          sessionName: '[aeolus-fleet] scout',
          prompt: '/aeolus:wake',
          isFirstStart: true,
          defaultPermissionMode: { kind: 'decided', mode: 'plan' },
          ...(permissionModes !== undefined && { permissionModes }),
        }),
      ).slice(1, 3);

    expect(overrideWith(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])).toEqual(['--permission-mode', 'manual']);
    expect(overrideWith(['acceptEdits', 'bypassPermissions', 'default', 'plan'])).toEqual(['--permission-mode', 'default']);
    expect(overrideWith()).toEqual(['--permission-mode', 'default']);
  });

  it('wakes a session by typing /aeolus:wake with the line that no human reads its terminal as its argument (#585)', async () => {
    await harness().wake({ shipId, folder });

    expect(typed).toEqual([{ shipId, text: `/aeolus:wake ${NO_TERMINAL_QUESTIONS}` }]);
  });

  it("reads the turn from the plugin's turn marker: unknown before the first prompt, then busy or idle", async () => {
    await harness().prepareIdentity({ folder, identity });
    await expect(harness().turnOf(folder)).resolves.toBe('unknown');

    const marked = await runCommand('bash', {
      args: [`${PLUGIN_ROOT}/scripts/aeolus-turn.sh`],
      env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_CREWS: crews },
      input: JSON.stringify({ cwd: folder, hook_event_name: 'UserPromptSubmit' }),
    });

    expect(marked.status).toBe(0);
    await expect(harness().turnOf(folder)).resolves.toBe('busy');
  });

});

describe("Claude Code's launch window, from the launch marker its session's hooks keep (#490)", () => {
  /** Runs the plugin's launch hook as Claude Code runs it in a session started for the launch given. */
  async function hooked(payload: Record<string, unknown>, launchId = LAUNCH_ID): Promise<void> {
    const marked = await runCommand('bash', {
      args: [`${PLUGIN_ROOT}/scripts/aeolus-launch.sh`],
      env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_CREWS: crews, AEOLUS_LAUNCH: launchId },
      input: JSON.stringify({ cwd: folder, transcript_path: '/a/transcript.jsonl', ...payload }),
    });
    expect(marked.status).toBe(0);
  }

  const sessionStarted = { hook_event_name: 'SessionStart', source: 'startup' };
  const aToolCall = { hook_event_name: 'PreToolUse', tool_name: 'Read' };
  const modelRefused = { hook_event_name: 'StopFailure', error: 'model_not_found', last_assistant_message: "There's an issue with the selected model (claude-nonexistent-9). It may not exist." };
  const seen = (model?: string) => harness().launchSeen({ shipId, folder, launchId: LAUNCH_ID, ...(model !== undefined && { model }) });

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

    await expect(seen('claude-opus-5-5')).resolves.toEqual({ kind: 'active' });
  });

  it('sees the model it launched with refused once the hooks marked a refusal', async () => {
    await hooked(sessionStarted);
    await hooked(modelRefused);

    await expect(seen('claude-nonexistent-9')).resolves.toEqual({ kind: 'refused', model: 'claude-nonexistent-9' });
  });

  it('sees the model the refusal names refused when it launched with none', async () => {
    await hooked(sessionStarted);
    await hooked(modelRefused);

    await expect(seen()).resolves.toEqual({ kind: 'refused', model: 'claude-nonexistent-9' });
  });

  it('sees a refusal that names no model as a refusal of no id when it launched with none', async () => {
    await hooked(sessionStarted);
    await hooked({ ...modelRefused, last_assistant_message: 'The model could not be found.' });

    await expect(seen()).resolves.toEqual({ kind: 'refused' });
  });

  it('reads no screen once its session started: none, whatever the screen shows', async () => {
    screens.set(shipId, readFileSync(new URL('../../test/screens/claude-code-bypass.txt', import.meta.url), 'utf8'));
    await hooked(sessionStarted);

    await expect(seen()).resolves.toEqual({ kind: 'none' });
  });

  it('names the screen its session stopped at when it never started', async () => {
    screens.set(shipId, readFileSync(new URL('../../test/screens/claude-code-bypass.txt', import.meta.url), 'utf8'));

    await expect(seen()).resolves.toEqual({ kind: 'none', screen: 'bypass permissions warning' });
  });

  it('counts nothing the hooks marked for another launch', async () => {
    screens.set(shipId, readFileSync(new URL('../../test/screens/claude-code-bypass.txt', import.meta.url), 'utf8'));
    await hooked(sessionStarted, 'launch-0');
    await hooked(aToolCall, 'launch-0');

    await expect(seen()).resolves.toEqual({ kind: 'none', screen: 'bypass permissions warning' });
  });

  it('says its aeolus plugin marks launches', async () => {
    await expect(harness().marksLaunches()).resolves.toBe(true);
  });

  it('says an aeolus plugin older than the launch marker, whose identity script has no launch command, marks none', async () => {
    const older = mkdtempSync(join(tmpdir(), 'trierarch-older-plugin-'));
    mkdirSync(join(older, 'scripts'));
    writeFileSync(join(older, 'scripts', 'aeolus-identity.sh'), 'echo "usage: aeolus-identity.sh write|check-in|show|turn|path|delete" >&2\nexit 2\n');

    await expect(harness({ pluginRoot: older }).marksLaunches()).resolves.toBe(false);
    rmSync(older, { recursive: true, force: true });
  });
});
