import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { HarnessPort } from '../core/ports.js';
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

export function createCodexHarness(options: {
  configuration: TrierarchConfiguration;
  plugin: AeolusPlugin;
  sessions: Pick<Tmux, 'start' | 'type'>;
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
      const program = options.command ?? 'codex';
      const command = isFirstStart ? [program, prompt] : [program, 'resume', '--last', prompt];
      const flags = effectiveFlags(settings, picked).filter((flag) => flag !== NO_DAEMON);
      await sessions.start({ shipId, folder, command: [...command, ...flags, NO_DAEMON] });
    },
    wake: async ({ shipId }) => {
      // The space closes Codex's skill picker, which would otherwise take the Enter.
      await sessions.type({ shipId, text: `${WAKE_PROMPT} `, settleMs: CODEX_TYPING_SETTLE_MS });
    },
  };
}
