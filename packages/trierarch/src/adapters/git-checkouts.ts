import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';

import type { Checkout, CheckoutsPort, RefreshedCheckout } from '../core/ports.js';
import type { TrierarchConfiguration } from './files.js';
import { bringToMain, makeReadOnlyClone, removeReadOnly } from './read-only-clone.js';

/**
 * Read-only checkouts in git (#1182; docs/trierarch.md, "Read-only
 * checkouts"): per ship, `<root>/<ship id>/<repository>`, a read-only clone
 * of the configured repository (read-only-clone.ts). A refresh whose fetch
 * fails answers a problem rather than the main the checkout held.
 */

export function createGitCheckouts(options: { configuration: TrierarchConfiguration; root: string }): CheckoutsPort {
  const { configuration, root } = options;
  const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;
  const pathOf = (repository: string): string => {
    const path = configuration.repositories[repository]?.path;
    if (path === undefined) {
      throw new Error(`The configuration has no repository ${repository}`);
    }
    return path;
  };

  return {
    prepare: async ({ shipId, repository }) => {
      const made: Checkout[] = [];
      for (const checkout of configuration.repositories[repository]?.checkouts ?? []) {
        const path = join(root, shipId, checkout);
        // A checkout the ship has already stays as it is: only a refresh moves it on.
        if (!(await exists(path))) {
          await mkdir(join(root, shipId), { recursive: true });
          await makeReadOnlyClone({ repository: pathOf(checkout), path });
        }
        made.push({ repository: checkout, path });
      }
      return made;
    },
    refresh: async (shipId: ShipId) => {
      const refreshed: RefreshedCheckout[] = [];
      for (const repository of (await readdir(join(root, shipId)).catch(() => [])).toSorted()) {
        try {
          refreshed.push({ repository, revision: await bringToMain({ repository: pathOf(repository), path: join(root, shipId, repository) }, { isFetchRequired: true }) });
        } catch (error) {
          refreshed.push({ repository, problem: (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '' });
        }
      }
      return refreshed;
    },
    remove: async (shipId) => {
      await removeReadOnly(join(root, shipId));
    },
  };
}
