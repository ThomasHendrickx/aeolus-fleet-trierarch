import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginHarness } from './plugin.js';

/**
 * Each harness's API key, one file per harness in `~/.aeolus/trierarch/keys/`
 * (api keys K5): mode 600 in a folder of mode 700. Only `aeolus-trierarch
 * login` writes it and only the model proxy reads it (K7), so this holds no
 * read: the key never comes back out of here into the trierarch.
 */
export interface KeyFiles {
  has(harness: PluginHarness): Promise<boolean>;
  write(harness: PluginHarness, key: string): Promise<void>;
  /** Whether there was a key to remove. */
  remove(harness: PluginHarness): Promise<boolean>;
}

export function createKeyFiles(folder: string): KeyFiles {
  const fileOf = (harness: PluginHarness): string => join(folder, harness);
  return {
    has: async (harness) =>
      stat(fileOf(harness)).then(
        () => true,
        () => false,
      ),
    write: async (harness, key) => {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await chmod(folder, 0o700);
      // Written beside it first, so the proxy never reads half a key.
      const next = `${fileOf(harness)}.next`;
      await writeFile(next, key, { mode: 0o600 });
      await chmod(next, 0o600);
      await rename(next, fileOf(harness));
    },
    remove: async (harness) => {
      const wasThere = await stat(fileOf(harness)).then(
        () => true,
        () => false,
      );
      await rm(fileOf(harness), { force: true });
      return wasThere;
    },
  };
}
