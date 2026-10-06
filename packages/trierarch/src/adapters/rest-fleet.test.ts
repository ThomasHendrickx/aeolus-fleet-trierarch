import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { createRestFleet } from './rest-fleet.js';

/** Nothing listens here: a connection is refused at once. */
const NOWHERE = 'http://127.0.0.1:9';

describe('the fleet over REST', () => {
  it('says which fleet cannot be reached, rather than only that a fetch failed', async () => {
    await expect(createRestFleet({ fleetUrl: NOWHERE, crewToken: '' }).registerSelf({ shipId: newId('ship'), secret: 'aeolus_sk_v1_x' })).rejects.toThrow(
      `The fleet at ${NOWHERE} cannot be reached: fetch failed`,
    );
  });

  it('ends a receive at once when it is stopped, while the fleet still holds the long poll', async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const stopping = new AbortController();
    try {
      const receiving = createRestFleet({ fleetUrl: `http://127.0.0.1:${String(port)}`, crewToken: 'aeolus_ct_v1_x' }).receive(stopping.signal);
      setTimeout(() => {
        stopping.abort();
      }, 20);

      await expect(receiving).rejects.toThrow();
      expect(stopping.signal.aborted).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
