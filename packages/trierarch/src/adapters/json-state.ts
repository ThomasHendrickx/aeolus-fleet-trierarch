import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { idSchema, trierarchWorkspaceSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

import { EMPTY_STATE, ENTRY_STATES, type TrierarchState } from '../core/entry.js';
import type { StatePort } from '../core/ports.js';

/**
 * The state store: `~/.aeolus/trierarch/state.json`, written whole and
 * atomically (a temporary file, then a rename), so a stop mid-write leaves the
 * last state. It holds no secret. A state file of the 0.17 protocol, whose
 * wanted list is not migrated (decision 0013), is moved aside to
 * `state.0.17.json` and the trierarch starts empty: its sessions are then
 * strays, stopped by the loop.
 */

/** Where a 0.17 state file is moved, beside the new one. */
export const OLD_STATE_FILE = 'state.0.17.json';

const stateSchema = z.object({
  entries: z.record(
    z.string(),
    z.object({
      shipId: idSchema('ship'),
      shipName: z.string().optional(),
      settingsVersion: z.int().positive(),
      harness: z.string(),
      workspace: trierarchWorkspaceSchema,
      squadron: z.string().optional(),
      firstPrompt: z.string().optional(),
      options: z.record(z.string(), z.string()),
      state: z.enum(ENTRY_STATES),
      since: z.string(),
      exits: z.array(z.string()),
      restartAt: z.string().optional(),
      folder: z.string().optional(),
      hasStarted: z.boolean(),
      wake: z.object({ waiting: z.int().nonnegative(), isPending: z.boolean() }),
    }),
  ),
  kept: z.array(z.object({ shipId: idSchema('ship'), path: z.string() })),
  orphans: z.array(z.string()),
  refused: z.record(z.string(), z.int().positive()),
});

/** The 0.17 state file: it alone kept the messages it applied. */
const oldStateSchema = z.looseObject({ applied: z.unknown() });

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function createJsonState(path: string): StatePort {
  return {
    load: async () => {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if (isMissing(error)) {
          return EMPTY_STATE;
        }
        throw error;
      }
      const json: unknown = JSON.parse(text);
      if (oldStateSchema.safeParse(json).success) {
        await rename(path, join(dirname(path), OLD_STATE_FILE));
        return EMPTY_STATE;
      }
      return stateSchema.parse(json);
    },
    save: async (state: TrierarchState) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}
