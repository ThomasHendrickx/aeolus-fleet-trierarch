import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { TrustedPlaces, TrustPort } from '../core/ports.js';
import { SKIP_PERMISSIONS } from './claude-code.js';
import { createClaudeCodeSetup } from './claude-code-setup.js';
import { codexTrustedFolders } from './codex-setup.js';

/**
 * What each configured harness trusts, read from its own files each time
 * (#381): Claude Code's ~/.claude.json, Codex's config.toml. A repository is
 * trusted when its own checkout is, as both ask about a worktree's
 * repository; a folder when its path is. A harness with no reader trusts
 * nothing. Claude Code's skip-permissions flag is unaccepted until bypass
 * permissions mode is accepted in its settings (#403); Codex asks about no
 * flag.
 */
export function createTrust(at: { configuration: TrierarchConfiguration; homeDirectory: string; env: Readonly<Record<string, string | undefined>>; managedSettings: string }): TrustPort {
  const { configuration, homeDirectory, env, managedSettings } = at;
  const claudeCode = createClaudeCodeSetup({ homeDirectory, managedSettings });
  const readers: Readonly<Record<string, (() => Promise<ReadonlySet<string>>) | undefined>> = {
    'claude-code': () => claudeCode.trustedFolders(),
    codex: () => codexTrustedFolders({ homeDirectory, env }),
  };
  const unaccepted: Readonly<Record<string, (() => Promise<readonly string[]>) | undefined>> = {
    'claude-code': async () => ((await claudeCode.isSkipPermissionsAccepted()) ? [] : [SKIP_PERMISSIONS]),
  };
  const namesIn = (places: TrierarchConfiguration['repositories'], trusted: ReadonlySet<string>): string[] =>
    Object.entries(places)
      .filter(([, place]) => trusted.has(place.path))
      .map(([name]) => name);

  return {
    trusted: async (): Promise<TrustedPlaces> => {
      const entries = await Promise.all(
        Object.keys(configuration.harnesses).map(async (harness) => {
          const trusted = (await readers[harness]?.()) ?? new Set<string>();
          const unacceptedFlags = (await unaccepted[harness]?.()) ?? [];
          return [harness, { repositories: namesIn(configuration.repositories, trusted), folders: namesIn(configuration.folders, trusted), unacceptedFlags }] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  };
}
