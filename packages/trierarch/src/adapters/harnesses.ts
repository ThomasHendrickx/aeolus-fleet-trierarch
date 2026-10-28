import { join } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { AdapterFlag, Detected, HarnessPort, SessionRuntime } from '../core/ports.js';
import { CLAUDE_CODE_ADAPTER_FLAGS, CLAUDE_CODE_RISKY_FLAGS, claudeCodeCommandLine, claudeCodeSettingsDefaultMode, createClaudeCodeHarness, WAKE_PROMPT as CLAUDE_CODE_WAKE_PROMPT } from './claude-code.js';
import { createClaudeCodeSetup, type ClaudeCodeSetup } from './claude-code-setup.js';
import { createCodexSetup } from './codex-setup.js';
import { CODEX_ADAPTER_FLAGS, CODEX_RISKY_FLAGS, codexCommandLine, createCodexHarness, WAKE_PROMPT as CODEX_WAKE_PROMPT } from './codex.js';
import type { CommandPart } from './command-line.js';
import { firstPromptOf, wakePromptOf } from '../core/no-terminal-questions.js';
import type { AeolusPlugin } from './plugin-identity.js';
import { findAeolusPlugin } from './plugin.js';

/** What the settings' first prompt stands for where config check shows a command line. */
const FIRST_PROMPT = '<first prompt>';

/** What config check reads of the harnesses' own files to show their command lines. */
export interface HarnessFiles {
  claudeCode: Pick<ClaudeCodeSetup, 'defaultPermissionMode'>;
}

interface CommandLines {
  firstStart: CommandPart[];
  restart: CommandPart[];
}

/** Per harness this trierarch has an adapter for: the flags it adds itself, its risky flags, and its command lines for given flags. */
const ADAPTERS: Readonly<
  Record<string, { adapterFlags: readonly AdapterFlag[]; riskyFlags: readonly string[]; commandLines: (flags: readonly string[], at: { files: HarnessFiles; permissionModes: readonly string[] | undefined; isHeadless: boolean }) => Promise<CommandLines> } | undefined>
> = {
  'claude-code': {
    adapterFlags: CLAUDE_CODE_ADAPTER_FLAGS,
    riskyFlags: CLAUDE_CODE_RISKY_FLAGS,
    commandLines: async (flags, { files, permissionModes, isHeadless }) => {
      const defaultPermissionMode = await claudeCodeSettingsDefaultMode(files.claudeCode, { flags });
      const commandLine = (isFirstStart: boolean) =>
        claudeCodeCommandLine({ flags, isHeadless, prompt: isFirstStart ? firstPromptOf(FIRST_PROMPT) : wakePromptOf(CLAUDE_CODE_WAKE_PROMPT), isFirstStart, defaultPermissionMode, permissionModes });
      return { firstStart: commandLine(true), restart: commandLine(false) };
    },
  },
  codex: {
    adapterFlags: CODEX_ADAPTER_FLAGS,
    riskyFlags: CODEX_RISKY_FLAGS,
    commandLines: (flags) => {
      const commandLine = (isFirstStart: boolean) => codexCommandLine({ flags, prompt: isFirstStart ? firstPromptOf(FIRST_PROMPT) : wakePromptOf(CODEX_WAKE_PROMPT), isFirstStart });
      return Promise.resolve({ firstStart: commandLine(true), restart: commandLine(false) });
    },
  },
};

/** The flags each configured harness's adapter adds itself, for describe. */
export function adapterFlagsOf(configuration: TrierarchConfiguration): Record<string, readonly AdapterFlag[]> {
  return Object.fromEntries(Object.keys(configuration.harnesses).map((name) => [name, ADAPTERS[name]?.adapterFlags ?? []]));
}

/** The flags each configured harness's adapter calls risky, for the report (#326). */
export function riskyFlagsOf(configuration: TrierarchConfiguration): Record<string, readonly string[]> {
  return Object.fromEntries(Object.keys(configuration.harnesses).map((name) => [name, ADAPTERS[name]?.riskyFlags ?? []]));
}

/** What a harness launches with the given flags, on a first start and a restart, headless or in a terminal, for config check; undefined without an adapter. */
export async function commandLinesOf(at: { harness: string; flags: readonly string[]; files: HarnessFiles; permissionModes: readonly string[] | undefined; isHeadless: boolean }): Promise<CommandLines | undefined> {
  return ADAPTERS[at.harness]?.commandLines(at.flags, { files: at.files, permissionModes: at.permissionModes, isHeadless: at.isHeadless });
}

/**
 * The adapters of the harnesses the configuration offers, by name, each with
 * the aeolus-fleet plugin its harness installed. A plugin is looked for only for a
 * harness on offer, so a machine without Codex needs no Codex plugin. A
 * configured harness this trierarch has no adapter for is refused at start,
 * so no request for it is ever crewed.
 */
export async function createHarnesses(at: {
  configuration: TrierarchConfiguration;
  homeDirectory: string;
  env: Readonly<Record<string, string | undefined>>;
  managedSettings: string;
  /** What detection last found, read at each launch (#517). */
  detected: () => Detected;
  sessions: Pick<SessionRuntime, 'start' | 'send' | 'interrupt' | 'events'>;
  /** For sessions in containers: a home of each ship's own (decision 0039); without, sessions run headless on the host (headless H4). */
  shipHomes?: { homes: string; managedSettings: string };
  /** Where sessions on an API key reach the model proxy (headless H16); none on a machine with no proxy. */
  proxyUrl?: () => Promise<string | undefined>;
}): Promise<{ harnesses: Record<string, HarnessPort>; plugins: Record<string, AeolusPlugin> }> {
  const { configuration, homeDirectory, env, managedSettings, detected, sessions, shipHomes, proxyUrl } = at;
  const harnesses: Record<string, HarnessPort> = {};
  const plugins: Record<string, AeolusPlugin> = {};
  for (const name of Object.keys(configuration.harnesses)) {
    if (name !== 'claude-code' && name !== 'codex') {
      throw new Error(`This trierarch has no adapter for the harness ${name}: it offers claude-code and codex`);
    }
    const plugin = await findAeolusPlugin({ homeDirectory, env, harness: name });
    plugins[name] = plugin;
    harnesses[name] = name === 'codex' ? createCodexHarness({ configuration, plugin, sessions, setup: createCodexSetup(), ...(proxyUrl !== undefined && { proxyUrl }) }) : createClaudeCodeHarness({ configuration, plugin, sessions, ...(proxyUrl !== undefined && { proxyUrl }), isHeadless: shipHomes === undefined, permissionModes: () => detected()['claude-code']?.permissionModes, projects: join(env.CLAUDE_CONFIG_DIR ?? join(homeDirectory, '.claude'), 'projects'), setup: createClaudeCodeSetup({ homeDirectory, managedSettings, ...(env.CLAUDE_CONFIG_DIR !== undefined && { configDirectory: env.CLAUDE_CONFIG_DIR }) }), ...(shipHomes !== undefined && { shipHomes }) });
  }
  return { harnesses, plugins };
}
