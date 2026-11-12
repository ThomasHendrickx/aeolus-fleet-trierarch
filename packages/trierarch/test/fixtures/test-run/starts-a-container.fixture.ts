import { writeFileSync } from 'node:fs';

import { inject, it } from 'vitest';

import { runCommand } from '../../../src/adapters/run-command.js';
import { buildTestSessionImage } from '../../support/podman.js';

const marker = process.env.AEOLUS_TEST_RUN_MARKER ?? '';
const HANG_MS = 600_000;

it('starts a container of the test session image, with a volume, and leaves it running', async () => {
  const image = await buildTestSessionImage(`localhost/aeolus-trierarch-test:${marker}`, { run: inject('trierarchTestRun') });
  const name = `trierarch-test-${marker}`;
  const started = await runCommand('podman', { args: ['run', '--detach', '--name', name, '--volume', '/data', image, 'sleep', '300'] });
  if (started.status !== 0) {
    throw new Error(`starting the container failed: ${started.stderr.trim()}`);
  }
  // The volume's name, for the test that runs this suite to look for after it.
  const mounted = await runCommand('podman', { args: ['inspect', name, '--format', '{{range .Mounts}}{{.Name}}{{end}}'] });
  writeFileSync(process.env.AEOLUS_TEST_RUN_VOLUME_FILE ?? '', mounted.stdout.trim());
  if (process.env.AEOLUS_TEST_RUN_ENDS === 'hangs') {
    // Until it is killed, as a run is interrupted.
    await new Promise((resolve) => setTimeout(resolve, HANG_MS));
  }
  if (process.env.AEOLUS_TEST_RUN_ENDS === 'fails') {
    throw new Error('the test fails, as a test of a run can');
  }
});
