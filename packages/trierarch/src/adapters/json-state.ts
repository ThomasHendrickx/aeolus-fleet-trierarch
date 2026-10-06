import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { idSchema, TRIERARCH_ENTRY_STATES, trierarchWorkspaceSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

import { EMPTY_STATE, type TrierarchState } from '../core/entry.js';
import type { StatePort } from '../core/ports.js';

/**
 * The state store: `~/.aeolus/trierarch/state.json`, written whole and
 * atomically (a temporary file, then a rename), so a stop mid-write leaves the
 * last state. It holds no secret. Only the most recent applied messages are
 * kept, enough for the fleet to deliver one again.
 */

/** How many applied messages the store keeps, newest last. */
export const APPLIED_CAP = 1000;

const outgoingSchema = z.object({
  to: idSchema('ship'),
  inReplyTo: z.string().optional(),
  name: z.string(),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string(),
});

const stateSchema = z.object({
  entries: z.record(
    z.string(),
    z.object({
      shipId: idSchema('ship'),
      harness: z.string(),
      workspace: trierarchWorkspaceSchema,
      squadron: z.string().optional(),
      firstPrompt: z.string().optional(),
      options: z.record(z.string(), z.string()),
      requester: idSchema('ship'),
      state: z.enum(TRIERARCH_ENTRY_STATES),
      since: z.string(),
      exits: z.array(z.string()),
      restartAt: z.string().optional(),
      folder: z.string().optional(),
      hasStarted: z.boolean(),
      release: z.object({ messageId: z.string(), sender: idSchema('ship'), isForced: z.boolean() }).optional(),
      wake: z.object({ waiting: z.int().nonnegative(), isPending: z.boolean() }),
    }),
  ),
  applied: z.record(z.string(), z.array(outgoingSchema)),
  kept: z.array(z.object({ shipId: idSchema('ship'), path: z.string() })),
  orphans: z.array(z.string()),
});

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
      return stateSchema.parse(JSON.parse(text));
    },
    save: async (state: TrierarchState) => {
      const applied = Object.fromEntries(Object.entries(state.applied).slice(-APPLIED_CAP));
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ ...state, applied }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}
