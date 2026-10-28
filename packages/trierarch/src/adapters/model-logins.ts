import type { ModelLoginsPort } from '../core/ports.js';
import type { CodexSetup } from './codex-setup.js';
import type { KeyFiles } from './key-files.js';
import { PLUGIN_HARNESSES, type PluginHarness } from './plugin.js';

/**
 * Whether a session can start on its login now (api keys K9): on an API key,
 * only once its harness holds one, so a session never starts to be refused by
 * the proxy, nor on its subscription instead (K2). On the subscription,
 * only when nothing the harness reads itself would put a key in reach (K6).
 * For now only sessions on the host reach the model proxy: containers follow.
 */
export function createModelLogins(at: {
  keys: Pick<KeyFiles, 'has'>;
  runtime: 'host' | 'container';
  /** What in Claude Code's settings would give a session in the folder a key, named; see ClaudeCodeSetup.keyInReach. */
  claudeCode: { keyInReach(at: { folder?: string }): Promise<string | undefined> };
  codex: Pick<CodexSetup, 'loginKind'>;
}): ModelLoginsPort {
  return {
    startProblem: async ({ harness, login, folder }) => {
      if (login === 'subscription') {
        return subscriptionProblem(at, { harness, ...(folder !== undefined && { folder }) });
      }
      if (at.runtime === 'container') {
        return 'a session on an API key runs on the host runtime only, until containers reach the model proxy';
      }
      const known = PLUGIN_HARNESSES.find((name): name is PluginHarness => name === harness);
      return known !== undefined && (await at.keys.has(known)) ? undefined : `${harness} has no API key on this computer: aeolus-trierarch login ${harness} --api-key`;
    },
  };
}

/** Why a session of the harness would not run on its subscription alone; none when it would. */
async function subscriptionProblem(at: Parameters<typeof createModelLogins>[0], session: { harness: string; folder?: string }): Promise<string | undefined> {
  if (session.harness === 'claude-code') {
    const found = await at.claudeCode.keyInReach(session.folder === undefined ? {} : { folder: session.folder });
    return found === undefined ? undefined : `claude-code would reach an API key on its subscription (${found}): remove it, or run the ship on its API key`;
  }
  if (session.harness === 'codex' && (await at.codex.loginKind()) === 'apiKey') {
    return 'codex is logged in with an API key, not ChatGPT: log Codex in with ChatGPT (codex logout, then codex login), or run the ship on its API key';
  }
  return undefined;
}
