import { inject, it } from 'vitest';

import { runCommand } from '../../../src/adapters/run-command.js';
import { buildTestSessionImage } from '../../support/podman.js';

const marker = process.env.AEOLUS_TEST_RUN_MARKER ?? '';
const HANG_MS = 600_000;

it('starts a container of the test session image and leaves it running', async () => {
  const image = await buildTestSessionImage(`localhost/aeolus-trierarch-test:${marker}`, { run: inject('trierarchTestRun') });
  const started = await runCommand('podman', { args: ['run', '--detach', '--name', `trierarch-test-${marker}`, image, 'sleep', '300'] });
  if (started.status !== 0) {
    throw new Error(`starting the container failed: ${started.stderr.trim()}`);
  }
  if (process.env.AEOLUS_TEST_RUN_HANGS === '1') {
    // Until it is killed, as a run is interrupted.
    await new Promise((resolve) => setTimeout(resolve, HANG_MS));
  }
});
