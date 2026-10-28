import type { ModelLoginsPort } from '../core/ports.js';
import type { CodexSetup } from './codex-setup.js';
import type { KeyStateAt } from '../core/login.js';
import type { KeyStates } from './key-states.js';
import { PLUGIN_HARNESSES, type PluginHarness } from './plugin.js';

/**
 * Whether a session can start on its login now (api keys K9): on an API key,
 * only once its harness holds one, so a session never starts to be refused by
 * the proxy, nor on its subscription instead (K2). On the subscription,
 * only when nothing the harness reads itself would put a key in reach (K6).
 * For now only sessions on the host reach the model proxy: containers follow.
 */
export function createModelLogins(at: {
  /** What the model proxy recorded of each key (api keys K8). */
  keyStates: Pick<KeyStates, 'stateOf'>;
  runtime: 'host' | 'container';
  /** What in Claude Code's settings would give a session with the options in the folder a key, named; see ClaudeCodeSetup.keyInReach. */
  claudeCode: { keyInReach(at: { options: Readonly<Record<string, string>>; folder?: string }): Promise<string | undefined> };
  codex: Pick<CodexSetup, 'loginKind'>;
}): ModelLoginsPort {
  return {
    startProblem: async ({ harness, login, options, folder }) => {
      if (login === 'subscription') {
        return subscriptionProblem(at, { harness, options, ...(folder !== undefined && { folder }) });
      }
      if (at.runtime === 'container') {
        return 'a session on an API key runs on the host runtime only, until containers reach the model proxy';
      }
      const { state, at: since = '' } = await keyStateOf(at, harness);
      switch (state) {
        case 'ready':
          return undefined;
        case 'none':
          return `${harness} has no API key on this computer: aeolus-trierarch login ${harness} --api-key`;
        case 'refused':
          return `${harness}'s API key was refused by its vendor since ${since}: give it a new one with aeolus-trierarch login ${harness} --api-key`;
        case 'outOfCredit':
          return `${harness}'s API key is out of credit since ${since}: it is checked every 15 minutes, or at once with aeolus-trierarch login ${harness} --check`;
      }
    },
    keyState: (harness) => keyStateOf(at, harness),
  };
}

/** The harness's key state; none for a harness this trierarch keeps no key for. */
function keyStateOf(at: { keyStates: Pick<KeyStates, 'stateOf'> }, harness: string): Promise<KeyStateAt> {
  const known = PLUGIN_HARNESSES.find((name): name is PluginHarness => name === harness);
  return known === undefined ? Promise.resolve({ state: 'none' }) : at.keyStates.stateOf(known);
}

/** Why a session of the harness would not run on its subscription alone; none when it would. */
async function subscriptionProblem(at: Parameters<typeof createModelLogins>[0], session: { harness: string; options: Readonly<Record<string, string>>; folder?: string }): Promise<string | undefined> {
  if (session.harness === 'claude-code') {
    const found = await at.claudeCode.keyInReach({ options: session.options, ...(session.folder !== undefined && { folder: session.folder }) });
    return found === undefined ? undefined : `claude-code would reach an API key on its subscription (${found}): remove it, or run the ship on its API key`;
  }
  if (session.harness === 'codex' && (await at.codex.loginKind()) === 'apiKey') {
    return 'codex is logged in with an API key, not ChatGPT: log Codex in with ChatGPT (codex logout, then codex login), or run the ship on its API key';
  }
  return undefined;
}
