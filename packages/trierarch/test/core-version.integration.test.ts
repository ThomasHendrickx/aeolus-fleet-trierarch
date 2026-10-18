import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../core/src/app.js';
import { FLEET_URL } from '../../core/test/support/core-fixtures.js';
import { createMigratedDatabase } from '../../core/test/support/database.js';
import { requireCoreVersion } from '../src/adapters/core-version.js';

let fleet: FastifyInstance;
let fleetUrl: string;

beforeEach(async () => {
  fleet = createApp({ databaseUrl: await createMigratedDatabase(), publicUrl: FLEET_URL, logger: false });
  fleetUrl = await fleet.listen({ host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  await fleet.close();
});

describe('the trierarch against a real core (decision 0049)', () => {
  it('reads the version core says and starts', async () => {
    await expect(requireCoreVersion(fleetUrl)).resolves.toBeUndefined();
  });
});
