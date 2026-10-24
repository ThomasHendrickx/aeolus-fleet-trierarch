import { describe, expect, it } from 'vitest';

import { CollectingLogger, InMemoryFleet, PLUGIN_SHIP_ID } from '../../test/support/in-memory.js';
import { createAskForTrustedRepositories } from './ask-for-trusted-repositories.js';

describe('asking the trierarch plugin for the trusted repositories (aeolus-fleet#384)', () => {
  it("asks the trierarch plugin's ship once, so a machine set up before gets the list it dropped", async () => {
    const fleet = new InMemoryFleet();
    const ask = createAskForTrustedRepositories({ fleet, logger: new CollectingLogger(), pluginShipId: PLUGIN_SHIP_ID });

    await ask();
    await ask();

    expect(fleet.askedForTrustedRepositories).toEqual([PLUGIN_SHIP_ID]);
  });

  it('asks again on the next pass when the fleet did not take the ask, saying so', async () => {
    const fleet = new InMemoryFleet();
    const logger = new CollectingLogger();
    const ask = createAskForTrustedRepositories({ fleet, logger, pluginShipId: PLUGIN_SHIP_ID });
    fleet.isRefusingAsks = true;
    await ask();
    fleet.isRefusingAsks = false;

    await ask();

    expect(fleet.askedForTrustedRepositories).toEqual([PLUGIN_SHIP_ID]);
    expect(logger.warnings).toEqual(["Could not ask the trierarch plugin's ship for the trusted repositories: the fleet refused it; the next pass asks again"]);
  });

  it("asks nothing on a machine that does not know the trierarch plugin's ship", async () => {
    const fleet = new InMemoryFleet();

    await createAskForTrustedRepositories({ fleet, logger: new CollectingLogger() })();

    expect(fleet.askedForTrustedRepositories).toEqual([]);
  });
});
