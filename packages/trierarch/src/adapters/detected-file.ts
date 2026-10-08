import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { trierarchNameSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { Detected, DetectedStore } from '../core/ports.js';

/**
 * The detected file, `~/.aeolus/trierarch/detected.json` (#365): what
 * detection found per harness, apart from the operator's configuration, which
 * the trierarch never writes. A file that is missing or does not fit holds
 * nothing, so detection runs again.
 */

const optionSchema = z.strictObject({ values: z.record(trierarchNameSchema, z.array(z.string())), default: trierarchNameSchema.optional() });

const detectedSchema = z.record(
  z.string(),
  z.strictObject({
    version: z.string().min(1),
    detectedAt: z.iso.datetime(),
    confirmedAt: z.iso.datetime().nullable(),
    options: z.record(trierarchNameSchema, optionSchema),
  }),
);

export function createDetectedFile(path: string): DetectedStore {
  return {
    load: async () => {
      let json: unknown;
      try {
        json = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return {};
      }
      const parsed = detectedSchema.safeParse(json);
      if (!parsed.success) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(parsed.data).map(([harness, found]) => [
          harness,
          { ...found, detectedAt: new Date(found.detectedAt), confirmedAt: found.confirmedAt === null ? null : new Date(found.confirmedAt) },
        ]),
      );
    },
    save: async (detected: Detected) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(detected, null, 2)}\n`);
    },
  };
}
