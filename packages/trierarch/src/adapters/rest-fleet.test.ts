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
});
