import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { AdapterFlag, HarnessPort } from '../core/ports.js';
import { codexLaunchSeen } from './codex-screen.js';
import { partsWithWords, wordsOf, type CommandPart } from './command-line.js';
import { effectiveFlags } from './flags.js';
import { createPluginIdentity, type AeolusPlugin } from './plugin-identity.js';
import type { Tmux } from './tmux.js';

/**
 * Codex as a harness (docs/architecture.md, "First adapters"): `codex` in the
 * folder, `codex resume --last` on a restart (the folder's last conversation;
 * one ship per folder), always with `--no-daemon`, and `$aeolus-wake` typed
 * to wake an idle session. The identity and the turn marker go through the
 * aeolus plugin for Codex, in Codex's own plugin data folder.
 */

export const WAKE_PROMPT = '$aeolus-wake';

/**
 * How long a typed wake waits before Enter. Codex takes an Enter that comes
 * right after fast typing as part of a paste, a newline, and submits nothing.
 */
export const CODEX_TYPING_SETTLE_MS = 1000;

/**
 * Added to every launch, as mechanism: without it Codex runs the session's
 * work in its shared app-server daemon, which keeps a turn running after the
 * pane is gone, so a release or a crash would stop the pane but not the work.
 */
const NO_DAEMON = '--no-daemon';
const END_OF_FLAGS = '--';

export const CODEX_ADAPTER_FLAGS: readonly AdapterFlag[] = [{ flag: NO_DAEMON, when: 'always' }];

/** The flags of Codex that are risky: it then runs every command without approval and outside its sandbox (#326). */
export const CODEX_RISKY_FLAGS: readonly string[] = ['--dangerously-bypass-approvals-and-sandbox'];

/** `codex`, or `codex resume --last` on a restart, then the configured flags, --no-daemon once, and the prompt last after `--`, so it never reads as a flag. */
export function codexCommandLine(at: { flags: readonly string[]; prompt: string; isFirstStart: boolean; program?: string }): CommandPart[] {
  const program = at.program ?? 'codex';
  return partsWithWords([
    { words: at.isFirstStart ? [program] : [program, 'resume', '--last'] },
    { words: at.flags.filter((flag) => flag !== NO_DAEMON), source: 'configuration' },
    { words: [NO_DAEMON], source: 'adapter' },
    { words: [END_OF_FLAGS, at.prompt] },
  ]);
}

export function createCodexHarness(options: {
  configuration: TrierarchConfiguration;
  plugin: AeolusPlugin;
  sessions: Pick<Tmux, 'start' | 'type' | 'screen'>;
  /** The program to run; `codex` unless a test runs another. */
  command?: string;
}): HarnessPort {
  const { configuration, plugin, sessions } = options;

  return {
    ...createPluginIdentity(plugin),
    launch: async ({ shipId, folder, harness, options: picked, isFirstStart, firstPrompt }) => {
      const settings = configuration.harnesses[harness];
      if (settings === undefined) {
        throw new Error(`The configuration has no harness ${harness}`);
      }
      const prompt = isFirstStart && firstPrompt !== undefined ? firstPrompt : WAKE_PROMPT;
      const command = codexCommandLine({ flags: effectiveFlags(settings, picked), prompt, isFirstStart, ...(options.command !== undefined && { program: options.command }) });
      await sessions.start({ shipId, folder, command: wordsOf(command) });
    },
    wake: async ({ shipId }) => {
      // The space closes Codex's skill picker, which would otherwise take the Enter.
      await sessions.type({ shipId, text: `${WAKE_PROMPT} `, settleMs: CODEX_TYPING_SETTLE_MS });
    },
    launchSeen: async ({ shipId, model }) => codexLaunchSeen({ screen: await sessions.screen(shipId), ...(model !== undefined && { model }) }),
  };
}
