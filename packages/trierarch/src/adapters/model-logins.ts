import type { ModelLoginsPort } from '../core/ports.js';
import type { KeyFiles } from './key-files.js';
import { PLUGIN_HARNESSES, type PluginHarness } from './plugin.js';

/**
 * Whether a session can start on its login now (api keys K9): on an API key,
 * only once its harness holds one, so a session never starts to be refused by
 * the proxy, nor on its subscription instead (K2). For now only Claude Code
 * on the host reaches the model proxy: Codex and containers follow.
 */
export function createModelLogins(at: { keys: Pick<KeyFiles, 'has'>; runtime: 'host' | 'container' }): ModelLoginsPort {
  return {
    startProblem: async ({ harness, login }) => {
      if (login === 'subscription') {
        return undefined;
      }
      if (harness === 'codex') {
        return 'codex does not run on an API key yet';
      }
      if (at.runtime === 'container') {
        return 'a session on an API key runs on the host runtime only, until containers reach the model proxy';
      }
      const known = PLUGIN_HARNESSES.find((name): name is PluginHarness => name === harness);
      return known !== undefined && (await at.keys.has(known)) ? undefined : `${harness} has no API key on this computer: aeolus-trierarch login ${harness} --api-key`;
    },
  };
}
