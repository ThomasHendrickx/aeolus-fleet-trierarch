import type { VersionFetch } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { requireCoreVersion } from './core-version.js';

/** A core that answers `/api/version` with this server version. */
function aCoreAt(server: string): VersionFetch {
  return () => Promise.resolve({ status: 200, json: () => Promise.resolve({ server, common: server }) });
}

describe('the trierarch starts only against a core it runs with (decision 0049)', () => {
  it('starts against a core at its minimum', async () => {
    await expect(requireCoreVersion('https://fleet.example', aCoreAt('0.34.1'))).resolves.toBeUndefined();
  });

  it('refuses to start against an older core, one without a register that states no harness (aeolus-fleet#1408), naming the trierarch and both versions', async () => {
    await expect(requireCoreVersion('https://fleet.example', aCoreAt('0.34.0'))).rejects.toThrow(
      new Error('trierarch 0.0.0 needs core 0.34.1 or later; the fleet at https://fleet.example runs core 0.34.0: upgrade core first'),
    );
  });

  it('refuses to start when the fleet does not answer', async () => {
    const down: VersionFetch = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:4000'));
    await expect(requireCoreVersion('https://fleet.example', down)).rejects.toThrow(
      new Error('trierarch 0.0.0 needs core 0.34.1 or later, and could not read the version of the fleet at https://fleet.example: connect ECONNREFUSED 127.0.0.1:4000'),
    );
  });
});
