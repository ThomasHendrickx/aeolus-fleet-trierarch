import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShipId, TrierarchConfiguration } from '@aeolus-fleet/common';

import type { Login } from '../core/login.js';
import type { AdapterFlag, HarnessPort, ProxyToken, SessionRuntime } from '../core/ports.js';
import { createHostClaudeCodeHomes, createShipClaudeCodeHomes } from './claude-code-home.js';
import { claudeCodeScreenStoppedAt } from './claude-code-screen.js';
import { parsedLine } from './hold-protocol.js';
import { SETTING_SOURCES, type ClaudeCodeSetup, type SettingsDefaultMode, type SettingSource } from './claude-code-setup.js';
import { partsWithWords, wordsOf, type CommandPart } from './command-line.js';
import { effectiveFlags } from '../core/effective-flags.js';
import { firstPromptOf, wakePromptOf } from '../core/no-terminal-questions.js';
import { createLaunchMarks } from './launch-marker.js';
import { createPluginIdentity, type AeolusPlugin } from './plugin-identity.js';
import { newProxyToken } from './proxy-tokens.js';

/**
 * Claude Code as a harness (docs/architecture.md, "First adapters"): `claude`
 * in the folder, `--continue` on a restart when the folder has a conversation
 * to continue, `/aeolus-fleet:wake` sent to wake an idle session, each prompt with
 * the line that no human reads its terminal (#585). On the host it runs
 * headless (headless H11): one long-lived `claude -p` taking user messages as
 * stream-json lines on stdin, each prompt one line, a busy turn stopped by its
 * hold, and a start that shows no activity explained by its last error event
 * (H13). In a container it still runs in a terminal, each prompt typed, until
 * S3 of the headless design. Always
 * without AskUserQuestion and plan mode: nobody watches the session's pane, so
 * it asks its questions over the fleet, and a question form or a plan approval
 * waiting there would take the keys of a wake (#457, #460). Plan mode goes as a
 * whole: without ExitPlanMode alone a session that entered it could never leave,
 * and for that reason a configured `--permission-mode plan` is ignored (#465),
 * and a default mode of plan from any of Claude Code's settings files is
 * overridden with `--permission-mode manual` when the flags name no mode of
 * their own (#505, #507), or `default` on a Claude Code whose --help lists no
 * manual mode (#517).
 * Its onboarding is completed before every launch, so a session on a machine
 * where Claude Code never ran by hand stops at no first-run screen (#403). A
 * session's identity is written and read through the aeolus
 * plugin's own `aeolus-identity.sh`, never a copy of how the plugin names its
 * files. On the host every session shares the user's home; with ship homes,
 * for sessions in containers, each ship's identity, conversations and Claude
 * Code's files live in a home of its own, removed with its identity
 * (decision 0039).
 */

export const WAKE_PROMPT = '/aeolus-fleet:wake';

/** The variable a session's launch id is passed in, for the plugin's hooks to mark that launch (#490). */
export const LAUNCH_VARIABLE = 'AEOLUS_LAUNCH';

/** Print mode, taking and giving stream-json: one long-lived process, one user message per stdin line (headless H11). */
const HEADLESS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
const CONTINUE = '--continue';
/** Lets the session read a folder beside its own without asking: each of its read-only checkouts (#1182). */
const ADD_DIR = '--add-dir';
const END_OF_FLAGS = '--';
const NO_PANE_PROMPTS = '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode';
const PERMISSION_MODE = '--permission-mode';
const PLAN_MODE = 'plan';
/** The mode that asks before each action: Claude Code names it manual where its --help lists that, and default before (#517). */
const MANUAL_MODE = 'manual';
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

/** What in the settings Claude Code reads with these flags would give a session a key instead of its subscription (api keys K6). */
export function claudeCodeKeyInReach(setup: Pick<ClaudeCodeSetup, 'keyInReach'>, at: { flags: readonly string[]; folder?: string }): Promise<string | undefined> {
  const settings = valueOf(at.flags, SETTINGS);
  return setup.keyInReach({ sources: settingSourcesOf(at.flags), ...(at.folder !== undefined && { folder: at.folder }), ...(settings !== undefined && { settings }) });
}

/** `--permission-mode manual` (or `default` where the installed Claude Code lists no manual) where the settings' default mode is plan and the flags name none, and with when it applies where that depends on the folder. */
function planOverride(flags: readonly string[], installed: { defaultMode: SettingsDefaultMode | undefined; permissionModes: readonly string[] | undefined }): CommandPart {
  const { defaultMode, permissionModes } = installed;
  if (namesPermissionMode(flags) || defaultMode === undefined || (defaultMode.kind === 'decided' && defaultMode.mode !== PLAN_MODE)) {
    return { words: [] };
  }
  const mode = permissionModes?.includes(MANUAL_MODE) === true ? MANUAL_MODE : DEFAULT_MODE;
  return { words: [PERMISSION_MODE, mode], source: 'adapter', ...(defaultMode.kind === 'per folder' && { when: WHEN_PLAN_PER_FOLDER }) };
}

/**
 * `claude`, headless in print mode with streamed JSON on the host, the flags
 * without plan mode, `--permission-mode manual` (or `default`, as the
 * installed Claude Code lists) when the settings' default mode is plan and the
 * flags name none (or where it depends on the folder, with when it applies),
 * AskUserQuestion and plan mode disallowed, `--continue` on a restart. In a
 * terminal, the prompt last after `--`, so it never reads as a flag; headless,
 * the prompt is the first line on stdin instead.
 */
export function claudeCodeCommandLine(at: {
  flags: readonly string[];
  /** The first prompt in a terminal; none headless, where it is sent as the first line. */
  prompt?: string;
  isHeadless: boolean;
  isFirstStart: boolean;
  defaultPermissionMode?: SettingsDefaultMode;
  permissionModes?: readonly string[] | undefined;
  program?: string;
  /** The session's read-only checkouts (#1182), which it reads beside its folder without asking. */
  readOnly?: readonly string[];
}): CommandPart[] {
  const flags = withoutPlanMode(at.flags);
  return partsWithWords([
    { words: [at.program ?? 'claude'] },
    { words: at.isHeadless ? HEADLESS : [], source: 'adapter' },
    { words: flags, source: 'configuration' },
    planOverride(flags, { defaultMode: at.defaultPermissionMode, permissionModes: at.permissionModes }),
    { words: [NO_PANE_PROMPTS], source: 'adapter' },
    { words: at.isFirstStart ? [] : [CONTINUE], source: 'adapter' },
    { words: (at.readOnly ?? []).flatMap((path) => [ADD_DIR, path]), source: 'adapter' },
    { words: at.isHeadless || at.prompt === undefined ? [] : [END_OF_FLAGS, at.prompt] },
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

/** A prompt as headless Claude Code takes it on stdin: one stream-json user message on one line. */
export function userLine(prompt: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } });
}

/** Why the harness's last error event says it failed (headless H13): a result that is an error, as a refused login; none without one. */
export function claudeCodeErrorIn(events: readonly string[]): string | undefined {
  for (const line of [...events].reverse()) {
    const event = parsedLine(line);
    if (typeof event === 'object' && event !== null && Reflect.get(event, 'type') === 'result' && Reflect.get(event, 'is_error') === true) {
      const result: unknown = Reflect.get(event, 'result');
      const subtype: unknown = Reflect.get(event, 'subtype');
      return typeof result === 'string' && result !== '' ? result : typeof subtype === 'string' ? subtype : 'an error';
    }
  }
  return undefined;
}

export function createClaudeCodeHarness(options: {
  configuration: TrierarchConfiguration;
  plugin: AeolusPlugin;
  sessions: Pick<SessionRuntime, 'start' | 'send' | 'interrupt' | 'events'>;
  /** Whether its sessions run headless, as on the host (headless H11), or in a terminal, as in a container until S3. */
  isHeadless: boolean;
  /** Claude Code's projects folder, where it keeps each folder's conversations. */
  projects: string;
  /** Claude Code's own files, where its onboarding is completed before each launch (#403) and its settings' default mode is read (#505, #507). */
  setup: Pick<ClaudeCodeSetup, 'completeOnboarding' | 'defaultPermissionMode' | 'isSkipPermissionsAccepted'>;
  /** For sessions in containers: a home of each ship's own under `homes`, in place of the host's (decision 0039). */
  shipHomes?: { homes: string; managedSettings: string };
  /** The permission modes the installed Claude Code lists, as detection last found them (#517); undefined before it found any. */
  permissionModes: () => readonly string[] | undefined;
  /** The program to run; `claude` unless a test runs another. */
  command?: string;
  /** Where sessions on an API key reach the model proxy (headless H16); none before it first listened, or on a machine with no proxy. */
  proxyUrl?: () => Promise<string | undefined>;
}): HarnessPort {
  const { configuration, plugin, sessions, isHeadless } = options;
  /**
   * The session's way to its model (api keys K6): on an API key, the model
   * proxy's address and a token of the session's own, fresh for each start;
   * on the subscription, nothing, so it signs in as Claude Code does.
   */
  const routeOf = async (login: Login): Promise<{ env: Record<string, string>; proxyToken?: ProxyToken }> => {
    if (login === 'subscription') {
      return { env: {} };
    }
    const url = await options.proxyUrl?.();
    if (url === undefined) {
      throw new Error('the model proxy is not running yet');
    }
    return { env: { ANTHROPIC_BASE_URL: `${url}/anthropic` }, proxyToken: { harness: 'claude-code', variable: 'ANTHROPIC_AUTH_TOKEN', token: newProxyToken() } };
  };
  /** A prompt as the session takes it: a stream-json line headless, the text typed in a terminal. */
  const lineOf = (prompt: string): string => (isHeadless ? userLine(prompt) : prompt);
  const homes =
    options.shipHomes === undefined
      ? createHostClaudeCodeHomes({ plugin, projects: options.projects, setup: options.setup })
      : createShipClaudeCodeHomes({ ...options.shipHomes, pluginRoot: plugin.root, host: options.setup });
  const identityOf = (shipId: ShipId) => createPluginIdentity(homes.of(shipId).plugin);
  const marksOf = (shipId: ShipId) => createLaunchMarks(homes.of(shipId).plugin);

  return {
    prepareIdentity: (at) => identityOf(at.identity.shipId).prepareIdentity(at),
    hasIdentity: (session) => identityOf(session.shipId).hasIdentity(session),
    removeIdentity: async (session) => {
      await identityOf(session.shipId).removeIdentity(session);
      await homes.remove(session.shipId);
    },
    turnOf: (session) => identityOf(session.shipId).turnOf(session),
    startProblem: () => createPluginIdentity(plugin).startProblem(),
    launch: async ({ shipId, folder, checkouts, harness, options: picked, isFirstStart, launchId, login, firstPrompt }) => {
      const settings = configuration.harnesses[harness];
      if (settings === undefined) {
        throw new Error(`The configuration has no harness ${harness}`);
      }
      const route = await routeOf(login);
      const home = homes.of(shipId);
      await homes.prepare({ shipId, folder });
      const prompt = isFirstStart && firstPrompt !== undefined ? firstPromptOf(firstPrompt) : wakePromptOf(WAKE_PROMPT);
      const flags = effectiveFlags(settings, picked);
      const command = claudeCodeCommandLine({
        flags,
        isHeadless,
        prompt,
        isFirstStart: isFirstStart || !(await hasConversation(home.projects, folder)),
        defaultPermissionMode: await claudeCodeSettingsDefaultMode(home.setup, { flags, folder }),
        permissionModes: options.permissionModes(),
        ...(options.command !== undefined && { program: options.command }),
        readOnly: checkouts.map((checkout) => checkout.path),
      });
      const marks = marksOf(shipId);
      await marks.clear(folder);
      await sessions.start({ shipId, folder, command: wordsOf(command), harness, env: { [LAUNCH_VARIABLE]: launchId, ...route.env }, ...(route.proxyToken !== undefined && { proxyToken: route.proxyToken }), ...(checkouts.length > 0 && { readOnly: checkouts.map((checkout) => checkout.path) }) });
      if (isHeadless) {
        await sessions.send({ shipId, line: userLine(prompt) });
      }
    },
    handOver: async (session) => {
      const line = await identityOf(session.shipId).handOverLine(session);
      if (line === undefined) {
        return 'nothing';
      }
      await sessions.send({ shipId: session.shipId, line: lineOf(wakePromptOf(line)) });
      return 'handed';
    },
    forceOver: async ({ shipId, folder, isTurnBusy }) => {
      const line = await identityOf(shipId).forceOverLine({ shipId, folder });
      if (line === undefined) {
        return 'nothing';
      }
      if (isTurnBusy) {
        await sessions.interrupt(shipId);
      }
      await sessions.send({ shipId, line: lineOf(wakePromptOf(line)) });
      return 'handed';
    },
    isHolding: (session) => identityOf(session.shipId).isHolding(session),
    sessionDied: (session) => identityOf(session.shipId).sessionDied(session),
    marksLaunches: () => createLaunchMarks(plugin).isMarking(),
    // The marker says what the session did; headless, the last error event names why a start shows none (H13); in a terminal, the screen names one that stopped it before its hooks ran (#490).
    launchSeen: async ({ shipId, folder, launchId, model }) => {
      const marker = await marksOf(shipId).read({ folder, launchId });
      if (marker?.refused !== undefined) {
        const refused = model ?? marker.refused.model;
        return { kind: 'refused', ...(refused !== undefined && { model: refused }) };
      }
      if (marker?.isActive === true) {
        return { kind: 'active' };
      }
      if (isHeadless) {
        const cause = claudeCodeErrorIn(await sessions.events(shipId));
        return { kind: 'none', ...(cause !== undefined && { cause }) };
      }
      const screen = marker?.isStarted === true ? undefined : claudeCodeScreenStoppedAt((await sessions.events(shipId)).join('\n'));
      return { kind: 'none', ...(screen !== undefined && { screen }) };
    },
  };
}
