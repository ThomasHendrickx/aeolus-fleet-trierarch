import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { KeyStateAt } from '../core/login.js';
import { parsedLine } from './hold-protocol.js';
import type { PluginHarness } from './plugin.js';

/**
 * Each harness's key state (api keys K8, K9): the model proxy records what
 * its vendor's answers say of the key, and the trierarch reads it. A state is
 * kept for the key file it was said of, by the file's identity, never its
 * content: a new key, which `login` writes as a new file, is ready again
 * (K10), and no key is none.
 */

export interface KeyStates {
  stateOf(harness: PluginHarness): Promise<KeyStateAt>;
  /** Keeps what the vendor's answer said of the harness's key now; a state it already has keeps its time, and a refused key stays refused until a new key. */
  record(harness: PluginHarness, said: { state: 'ready' | 'refused' | 'outOfCredit'; at: Date }): Promise<void>;
}

const recordedSchema = z.record(z.string(), z.object({ state: z.enum(['refused', 'outOfCredit']), at: z.string(), keyFile: z.object({ ino: z.number(), mtimeMs: z.number() }) }));

function isSameFile(left: { ino: number; mtimeMs: number }, right: { ino: number; mtimeMs: number }): boolean {
  return left.ino === right.ino && left.mtimeMs === right.mtimeMs;
}

export function createKeyStates(at: { keys: string; file: string }): KeyStates {
  const keyFileOf = async (harness: PluginHarness): Promise<{ ino: number; mtimeMs: number } | undefined> => {
    const found = await stat(join(at.keys, harness)).catch(() => undefined);
    return found === undefined ? undefined : { ino: found.ino, mtimeMs: found.mtimeMs };
  };
  const recorded = async (): Promise<z.infer<typeof recordedSchema>> => recordedSchema.safeParse(parsedLine(await readFile(at.file, 'utf8').catch(() => ''))).data ?? {};

  return {
    stateOf: async (harness) => {
      const keyFile = await keyFileOf(harness);
      if (keyFile === undefined) {
        return { state: 'none' };
      }
      const said = (await recorded())[harness];
      return said !== undefined && isSameFile(said.keyFile, keyFile) ? { state: said.state, at: said.at } : { state: 'ready' };
    },
    record: async (harness, said) => {
      const keyFile = await keyFileOf(harness);
      const all = await recorded();
      const before = all[harness];
      // A refused key leaves refused only as a new key login writes (K10), never by a later answer for the same key.
      const isStillRefused = keyFile !== undefined && before?.state === 'refused' && isSameFile(before.keyFile, keyFile);
      const isUnchanged = isStillRefused || (said.state === 'ready' ? before === undefined : keyFile === undefined || (before?.state === said.state && isSameFile(before.keyFile, keyFile)));
      if (isUnchanged) {
        return;
      }
      const others = Object.fromEntries(Object.entries(all).filter(([name]) => name !== harness));
      const next = said.state === 'ready' || keyFile === undefined ? others : { ...others, [harness]: { state: said.state, at: said.at.toISOString(), keyFile } };
      await mkdir(dirname(at.file), { recursive: true, mode: 0o700 });
      const temporary = `${at.file}.next`;
      await writeFile(temporary, JSON.stringify(next));
      await rename(temporary, at.file);
    },
  };
}
