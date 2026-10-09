import { join } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { AdapterFlag, HarnessPort } from '../core/ports.js';
import { CLAUDE_CODE_ADAPTER_FLAGS, CLAUDE_CODE_RISKY_FLAGS, claudeCodeCommandLine, createClaudeCodeHarness, WAKE_PROMPT as CLAUDE_CODE_WAKE_PROMPT } from './claude-code.js';
import { CODEX_ADAPTER_FLAGS, CODEX_RISKY_FLAGS, codexCommandLine, createCodexHarness, WAKE_PROMPT as CODEX_WAKE_PROMPT } from './codex.js';
import type { CommandPart } from './command-line.js';
import type { AeolusPlugin } from './plugin-identity.js';
import { findAeolusPlugin } from './plugin.js';
import type { Tmux } from './tmux.js';

/** What the settings' first prompt and a ship's session name stand for where config check shows a command line. */
const FIRST_PROMPT = '<first prompt>';
const SESSION_NAME = '[<repository or folder>] <ship>';

/** Per harness this trierarch has an adapter for: the flags it adds itself, its risky flags, and its command line for given flags. */
const ADAPTERS: Readonly<
  Record<
    string,
    { adapterFlags: readonly AdapterFlag[]; riskyFlags: readonly string[]; commandLine: (at: { flags: readonly string[]; isFirstStart: boolean }) => CommandPart[] } | undefined
  >
> = {
  'claude-code': {
    adapterFlags: CLAUDE_CODE_ADAPTER_FLAGS,
    riskyFlags: CLAUDE_CODE_RISKY_FLAGS,
    commandLine: ({ flags, isFirstStart }) => claudeCodeCommandLine({ flags, sessionName: SESSION_NAME, prompt: isFirstStart ? FIRST_PROMPT : CLAUDE_CODE_WAKE_PROMPT, isFirstStart }),
  },
  codex: {
    adapterFlags: CODEX_ADAPTER_FLAGS,
    riskyFlags: CODEX_RISKY_FLAGS,
    commandLine: ({ flags, isFirstStart }) => codexCommandLine({ flags, prompt: isFirstStart ? FIRST_PROMPT : CODEX_WAKE_PROMPT, isFirstStart }),
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

/** What a harness launches with the given flags, on a first start and a restart, for config check; undefined without an adapter. */
export function commandLinesOf(harness: string, flags: readonly string[]): { firstStart: CommandPart[]; restart: CommandPart[] } | undefined {
  const adapter = ADAPTERS[harness];
  return adapter === undefined ? undefined : { firstStart: adapter.commandLine({ flags, isFirstStart: true }), restart: adapter.commandLine({ flags, isFirstStart: false }) };
}

/**
 * The adapters of the harnesses the configuration offers, by name, each with
 * the aeolus plugin its harness installed. A plugin is looked for only for a
 * harness on offer, so a machine without Codex needs no Codex plugin. A
 * configured harness this trierarch has no adapter for is refused at start,
 * so no request for it is ever crewed.
 */
export async function createHarnesses(at: {
  configuration: TrierarchConfiguration;
  homeDirectory: string;
  env: Readonly<Record<string, string | undefined>>;
  sessions: Pick<Tmux, 'start' | 'type' | 'screen'>;
}): Promise<{ harnesses: Record<string, HarnessPort>; plugins: Record<string, AeolusPlugin> }> {
  const { configuration, homeDirectory, env, sessions } = at;
  const harnesses: Record<string, HarnessPort> = {};
  const plugins: Record<string, AeolusPlugin> = {};
  for (const name of Object.keys(configuration.harnesses)) {
    if (name !== 'claude-code' && name !== 'codex') {
      throw new Error(`This trierarch has no adapter for the harness ${name}: it offers claude-code and codex`);
    }
    const plugin = await findAeolusPlugin({ homeDirectory, env, harness: name });
    plugins[name] = plugin;
    harnesses[name] = name === 'codex' ? createCodexHarness({ configuration, plugin, sessions }) : createClaudeCodeHarness({ configuration, plugin, sessions, projects: join(env.CLAUDE_CONFIG_DIR ?? join(homeDirectory, '.claude'), 'projects') });
  }
  return { harnesses, plugins };
}
