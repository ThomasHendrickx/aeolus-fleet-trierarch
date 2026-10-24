import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { TrustedRepositoriesPort } from '../core/ports.js';
import { readTrustedRepositories, type TrustedRepository } from '../core/trusted-repositories.js';

/**
 * The trusted repositories file, `~/.aeolus/trierarch/trusted-repositories.json`
 * (aeolus-fleet#384): the list the trierarch plugin sent last, as it sent it,
 * apart from the operator's configuration, which the trierarch never writes.
 * A file that is missing or does not fit holds none, so a list written by
 * hand trusts nothing. Each repository's clone is `<clones root>/<name>`.
 */
export function createTrustedRepositoriesFile(at: {
  file: string;
  clonesRoot: string;
  /** Trusts the clones' paths for every configured harness, as adding a place does (#381). */
  trustClones: (paths: readonly string[]) => Promise<void>;
}): TrustedRepositoriesPort & { load(): Promise<void>; cloneOf(name: string): string } {
  let current: readonly TrustedRepository[] = [];
  const cloneOf = (name: string): string => join(at.clonesRoot, name);
  return {
    load: async () => {
      const text = await readFile(at.file, 'utf8').catch(() => undefined);
      const read = text === undefined ? undefined : readTrustedRepositories(text);
      current = read?.isOk === true ? read.value : [];
    },
    current: () => current,
    cloneOf,
    accept: async (list) => {
      await at.trustClones(list.map(({ name }) => cloneOf(name)));
      await mkdir(dirname(at.file), { recursive: true });
      await writeFile(at.file, `${JSON.stringify({ repositories: list }, null, 2)}\n`);
      current = list;
    },
  };
}
