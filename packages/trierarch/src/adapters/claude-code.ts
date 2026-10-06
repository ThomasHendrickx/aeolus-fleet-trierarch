import type { TrierarchAdapterFlag, TrierarchConfiguration } from '@aeolus-fleet/common';

import type { HarnessPort } from '../core/ports.js';
import { partsWithWords, wordsOf, type CommandPart } from './command-line.js';
import { effectiveFlags } from './flags.js';
import { createPluginIdentity, type AeolusPlugin } from './plugin-identity.js';
import type { Tmux } from './tmux.js';

/**
 * Claude Code as a harness (docs/architecture.md, "First adapters"): `claude`
 * in the folder, `--continue` on a restart, `/aeolus:wake` typed to wake an
 * idle session. A session's identity is written and read through the aeolus
 * plugin's own `aeolus-identity.sh`, never a copy of how the plugin names its
 * files.
 */

export const WAKE_PROMPT = '/aeolus:wake';

const REMOTE_CONTROL = '--remote-control';
const CONTINUE = '--continue';

export const CLAUDE_CODE_ADAPTER_FLAGS: readonly TrierarchAdapterFlag[] = [{ flag: CONTINUE, when: 'restart' }];

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

/** `claude <prompt>`, the prompt before the flags (a flag with an optional value, such as `--remote-control [name]`, would take it), then `--continue` on a restart. */
export function claudeCodeCommandLine(at: { flags: readonly string[]; sessionName: string; prompt: string; isFirstStart: boolean; program?: string }): CommandPart[] {
  return partsWithWords([
    { words: [at.program ?? 'claude', at.prompt] },
    ...namedRemoteControl(at.flags, at.sessionName),
    { words: at.isFirstStart ? [] : [CONTINUE], source: 'adapter' },
  ]);
}

export function createClaudeCodeHarness(options: {
  configuration: TrierarchConfiguration;
  plugin: AeolusPlugin;
  sessions: Pick<Tmux, 'start' | 'type'>;
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
      const command = claudeCodeCommandLine({
        flags: effectiveFlags(settings, picked),
        sessionName: `[${workspace.kind === 'worktree' ? workspace.repository : workspace.name}] ${shipName}`,
        prompt,
        isFirstStart,
        ...(options.command !== undefined && { program: options.command }),
      });
      await sessions.start({ shipId, folder, command: wordsOf(command) });
    },
    wake: async ({ shipId }) => {
      await sessions.type({ shipId, text: WAKE_PROMPT });
    },
  };
}
