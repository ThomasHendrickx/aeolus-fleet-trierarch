import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { HarnessPort } from '../core/ports.js';
import { createClaudeCodeHarness } from './claude-code.js';
import { createCodexHarness } from './codex.js';
import type { AeolusPlugin } from './plugin-identity.js';
import { findAeolusPlugin } from './plugin.js';
import type { Tmux } from './tmux.js';

/**
 * The adapters of the harnesses the configuration offers, by name, each with
 * the aeolus plugin its harness installed. A plugin is looked for only for a
 * harness on offer, so a machine without Codex needs no Codex plugin. A
 * configured harness this trierarch has no adapter for is refused at start,
 * so no want for it is ever taken.
 */
export async function createHarnesses(at: {
  configuration: TrierarchConfiguration;
  homeDirectory: string;
  env: Readonly<Record<string, string | undefined>>;
  sessions: Pick<Tmux, 'start' | 'type'>;
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
    harnesses[name] = name === 'codex' ? createCodexHarness({ configuration, plugin, sessions }) : createClaudeCodeHarness({ configuration, plugin, sessions });
  }
  return { harnesses, plugins };
}
