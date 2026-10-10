import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { AdapterFlag, HarnessPort } from '../core/ports.js';
import { claudeCodeLaunchSeen } from './claude-code-screen.js';
import { SETTING_SOURCES, type ClaudeCodeSetup, type SettingsDefaultMode, type SettingSource } from './claude-code-setup.js';
import { partsWithWords, wordsOf, type CommandPart } from './command-line.js';
import { effectiveFlags } from '../core/effective-flags.js';
import { createPluginIdentity, type AeolusPlugin } from './plugin-identity.js';
import type { Tmux } from './tmux.js';

/**
 * Claude Code as a harness (docs/architecture.md, "First adapters"): `claude`
 * in the folder, `--continue` on a restart when the folder has a conversation
 * to continue, `/aeolus:wake` typed to wake an idle session, and always
 * without AskUserQuestion and plan mode: nobody watches the session's pane, so
 * it asks its questions over the fleet, and a question form or a plan approval
 * waiting there would take the keys of a wake (#457, #460). Plan mode goes as a
 * whole: without ExitPlanMode alone a session that entered it could never leave,
 * and for that reason a configured `--permission-mode plan` is ignored (#465),
 * and a default mode of plan from any of Claude Code's settings files is
 * overridden with `--permission-mode default` when the flags name no mode of
 * their own (#505, #507).
 * Its onboarding is completed before every launch, so a session on a machine
 * where Claude Code never ran by hand stops at no first-run screen (#403). A
 * session's identity is written and read through the aeolus
 * plugin's own `aeolus-identity.sh`, never a copy of how the plugin names its
 * files.
 */

export const WAKE_PROMPT = '/aeolus:wake';

const REMOTE_CONTROL = '--remote-control';
const CONTINUE = '--continue';
const END_OF_FLAGS = '--';
const NO_PANE_PROMPTS = '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode';
const PERMISSION_MODE = '--permission-mode';
const PLAN_MODE = 'plan';
const DEFAULT_MODE = 'default';
const SETTINGS = '--settings';
const SETTING_SOURCES_FLAG = '--setting-sources';
const RESTRICTED = '--restricted';
/** Where config check cannot know the folder: the override is shown with when it applies. */
const WHEN_PLAN_PER_FOLDER = 'the Claude Code settings for the folder make plan the default mode';

export const CLAUDE_CODE_ADAPTER_FLAGS: readonly AdapterFlag[] = [
  { flag: NO_PANE_PROMPTS, when: 'always' },
  { flag: CONTINUE, when: 'restart' },
];

/** Claude Code's flag that runs every tool without asking; it asks once per user to accept that (#403). */
export const SKIP_PERMISSIONS = '--dangerously-skip-permissions';

/** The flags of Claude Code that are risky: it then runs every tool without asking (#326). */
export const CLAUDE_CODE_RISKY_FLAGS: readonly string[] = [SKIP_PERMISSIONS];

/** The flags without `--permission-mode plan` (or `=plan`): a session started in plan mode could never leave it (#465). */
function withoutPlanMode(flags: readonly string[]): string[] {
  const startsPlanMode = (at: number) => flags[at] === PERMISSION_MODE && flags[at + 1] === PLAN_MODE;
  return flags.filter((flag, at) => flag !== `${PERMISSION_MODE}=${PLAN_MODE}` && !startsPlanMode(at) && !startsPlanMode(at - 1));
}

/** Whether the flags start Claude Code in a permission mode of their own, which wins over its settings' default mode. */
function namesPermissionMode(flags: readonly string[]): boolean {
  return flags.some((flag) => flag === PERMISSION_MODE || flag.startsWith(`${PERMISSION_MODE}=`) || flag === SKIP_PERMISSIONS);
}

/** A flag's value, given as `<flag> <value>` or `<flag>=<value>`; the last one wins. */
function valueOf(flags: readonly string[], flag: string): string | undefined {
  return flags.flatMap((word, at) => (word === flag ? [flags[at + 1]] : word.startsWith(`${flag}=`) ? [word.slice(flag.length + 1)] : [])).findLast((value) => value !== undefined);
}

/** The settings sources Claude Code loads with the flags: none with `--restricted`, those `--setting-sources` names, else all. */
function settingSourcesOf(flags: readonly string[]): readonly SettingSource[] {
  if (flags.includes(RESTRICTED)) {
    return [];
  }
  const named = valueOf(flags, SETTING_SOURCES_FLAG)?.split(',').map((source) => source.trim());
  return named === undefined ? SETTING_SOURCES : SETTING_SOURCES.filter((source) => named.includes(source));
}

/** The default mode Claude Code's settings give a session started with the flags, in the folder or, without one, for config check. */
export function claudeCodeSettingsDefaultMode(setup: Pick<ClaudeCodeSetup, 'defaultPermissionMode'>, at: { flags: readonly string[]; folder?: string }): Promise<SettingsDefaultMode> {
  const settings = valueOf(at.flags, SETTINGS);
  return setup.defaultPermissionMode({ sources: settingSourcesOf(at.flags), ...(at.folder !== undefined && { folder: at.folder }), ...(settings !== undefined && { settings }) });
}

/** `--permission-mode default` where the settings' default mode is plan and the flags name none, and with when it applies where that depends on the folder. */
function planOverride(flags: readonly string[], defaultMode: SettingsDefaultMode | undefined): CommandPart {
  if (namesPermissionMode(flags) || defaultMode === undefined || (defaultMode.kind === 'decided' && defaultMode.mode !== PLAN_MODE)) {
    return { words: [] };
  }
  return { words: [PERMISSION_MODE, DEFAULT_MODE], source: 'adapter', ...(defaultMode.kind === 'per folder' && { when: WHEN_PLAN_PER_FOLDER }) };
}

/**
 * The configured flags, with a name for the remote-control session where the
 * operator gave `--remote-control` without one: `[<repository or folder>]
 * <ship>`, so the session is easy to find among the operator's
 * remote-control sessions. A name the operator gave is kept; without the
 * flag nothing is added.
 */
function namedRemoteControl(flags: readonly string[], name: string): CommandPart[] {
  const at = flags.indexOf(REMOTE_CONTROL);
  const next = flags[at + 1];
  if (at === -1 || (next !== undefined && !next.startsWith('-'))) {
    return [{ words: flags, source: 'configuration' }];
  }
  return [
    { words: flags.slice(0, at + 1), source: 'configuration' },
    { words: [name], source: 'adapter' },
    { words: flags.slice(at + 1), source: 'configuration' },
  ];
}

/** `claude`, the flags without plan mode, `--permission-mode default` when the settings' default mode is plan and the flags name none (or where it depends on the folder, with when it applies), AskUserQuestion and plan mode disallowed, `--continue` on a restart, then the prompt last after `--`: no flag takes it (`--remote-control [name]` has an optional value), and it never reads as a flag. */
export function claudeCodeCommandLine(at: { flags: readonly string[]; sessionName: string; prompt: string; isFirstStart: boolean; defaultPermissionMode?: SettingsDefaultMode; program?: string }): CommandPart[] {
  const flags = withoutPlanMode(at.flags);
  return partsWithWords([
    { words: [at.program ?? 'claude'] },
    ...namedRemoteControl(flags, at.sessionName),
    planOverride(flags, at.defaultPermissionMode),
    { words: [NO_PANE_PROMPTS], source: 'adapter' },
    { words: at.isFirstStart ? [] : [CONTINUE], source: 'adapter' },
    { words: [END_OF_FLAGS, at.prompt] },
  ]);
}

/**
 * Whether Claude Code keeps a conversation for the folder: it keeps each in
 * its projects folder, under the folder's path with every character other
 * than a letter or digit as `-`. Without one, `claude --continue` exits at
 * once (#381), so a restart starts fresh instead.
 */
async function hasConversation(projects: string, folder: string): Promise<boolean> {
  try {
    return (await readdir(join(projects, folder.replace(/[^a-zA-Z0-9]/g, '-')))).some((file) => file.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

export function createClaudeCodeHarness(options: {
  configuration: TrierarchConfiguration;
  plugin: AeolusPlugin;
  sessions: Pick<Tmux, 'start' | 'type' | 'screen'>;
  /** Claude Code's projects folder, where it keeps each folder's conversations. */
  projects: string;
  /** Claude Code's own files, where its onboarding is completed before each launch (#403) and its settings' default mode is read (#505, #507). */
  setup: Pick<ClaudeCodeSetup, 'completeOnboarding' | 'defaultPermissionMode'>;
  /** The program to run; `claude` unless a test runs another. */
  command?: string;
}): HarnessPort {
  const { configuration, plugin, sessions } = options;

  return {
    ...createPluginIdentity(plugin),
    launch: async ({ shipId, shipName, folder, workspace, harness, options: picked, isFirstStart, firstPrompt }) => {
      const settings = configuration.harnesses[harness];
      if (settings === undefined) {
        throw new Error(`The configuration has no harness ${harness}`);
      }
      const prompt = isFirstStart && firstPrompt !== undefined ? firstPrompt : WAKE_PROMPT;
      const flags = effectiveFlags(settings, picked);
      const command = claudeCodeCommandLine({
        flags,
        sessionName: `[${workspace.kind === 'worktree' ? workspace.repository : workspace.name}] ${shipName}`,
        prompt,
        isFirstStart: isFirstStart || !(await hasConversation(options.projects, folder)),
        defaultPermissionMode: await claudeCodeSettingsDefaultMode(options.setup, { flags, folder }),
        ...(options.command !== undefined && { program: options.command }),
      });
      await options.setup.completeOnboarding();
      await sessions.start({ shipId, folder, command: wordsOf(command) });
    },
    wake: async ({ shipId }) => {
      await sessions.type({ shipId, text: WAKE_PROMPT });
    },
    launchSeen: async ({ shipId, model }) => claudeCodeLaunchSeen({ screen: await sessions.screen(shipId), ...(model !== undefined && { model }) }),
  };
}
