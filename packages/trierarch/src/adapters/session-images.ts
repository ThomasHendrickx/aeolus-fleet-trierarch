import { z } from 'zod';

import { runCommand } from './run-command.js';

const SESSION_IMAGE = 'ghcr.io/thomashendrickx/aeolus-session';
/** No runtime command may hang the pass. */
const COMMAND_TIMEOUT_MS = 60_000;
const tagsSchema = z.array(z.string());

/** Removes only old session images, never forcing removal of an image a container uses. */
export function createSessionImages(options: { binary: string; version: string; run?: typeof runCommand }): { removeUnused(): Promise<void> } {
  const run = options.run ?? runCommand;
  const command = async (args: readonly string[]): Promise<string> => {
    const result = await run(options.binary, { args, timeoutMs: COMMAND_TIMEOUT_MS });
    if (result.isTimedOut === true) throw new Error(`Session images: ${args[0] ?? 'command'} timed out`);
    if (result.status !== 0) throw new Error(`Session images: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  const removeUnused = async (): Promise<void> => {
    const listed = await command(['image', 'ls', '--filter', `reference=${SESSION_IMAGE}:*`, '--no-trunc', '--format', '{{.ID}}']);
    const failures: string[] = [];
    for (const id of new Set(listed.split('\n').filter(Boolean))) {
      // One image failing (for example several tags, which a non-forced removal refuses) leaves the others to go.
      try {
        const tags = tagsSchema.parse(JSON.parse(await command(['image', 'inspect', id, '--format', '{{json .RepoTags}}'])));
        if (tags.length === 0 || tags.includes(`${SESSION_IMAGE}:${options.version}`) || tags.some((tag) => !tag.startsWith(`${SESSION_IMAGE}:`))) continue;
        // Includes stopped containers too. A container created after this check still makes a non-forced removal fail safely.
        const containers = await command(['ps', '--all', '--filter', `ancestor=${id}`, '--format', '{{.ID}}']);
        if (containers !== '') continue;
        await command(['rmi', id]);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
  };
  return {
    // A machine without the runtime has no session images to remove: nothing to retry.
    removeUnused: async () => removeUnused().catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }),
  };
}
