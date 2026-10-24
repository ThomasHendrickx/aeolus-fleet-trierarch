import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { TrustedRepositoriesPort } from '../core/ports.js';
import { offeredRepositories, readTrustedRepositories, type TrustedRepository } from '../core/trusted-repositories.js';
import type { TrierarchConfiguration } from './files.js';
import type { TrustedClones } from './trusted-clones.js';

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

/** The trusted repositories as the trierarch holds them now, and where each one's clone is. */
export type HeldTrustedRepositories = Pick<TrustedRepositoriesPort, 'current'> & { cloneOf(name: string): string };

/**
 * The configuration with each trusted repository beside the configured ones,
 * at its clone, read afresh at each use, as the list changes while the
 * trierarch runs: what it reports, checks, trusts and crews in.
 */
export function withTrustedRepositories<C extends TrierarchConfiguration>(base: C, held: HeldTrustedRepositories): C {
  return {
    ...base,
    get repositories() {
      return offeredRepositories(base.repositories, { trusted: held.current(), cloneOf: (name) => held.cloneOf(name) });
    },
  };
}

/** What a workspace clones first: each trusted repository the configuration does not name, from its URL on the list now. */
export function trustedClonesOf(at: { configured: TrierarchConfiguration; held: HeldTrustedRepositories; root: string; protocols?: string }): TrustedClones {
  const { configured, held } = at;
  return {
    root: at.root,
    urlOf: (name) => (name in configured.repositories ? undefined : held.current().find((each) => each.name === name)?.url),
    ...(at.protocols !== undefined && { protocols: at.protocols }),
  };
}
