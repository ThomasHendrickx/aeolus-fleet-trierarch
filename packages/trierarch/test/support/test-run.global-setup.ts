import type { TestProject } from 'vitest/node';

import { runCommand } from '../../src/adapters/run-command.js';
import { rootlessPodman } from './podman.js';
import { removeEarlierRuns, removeRun, runOf } from './test-run.js';

/**
 * Around the whole run: removes what earlier runs left before it starts, and
 * what this run left after it ends (#345). Gives each test this run's value
 * of the test run label. Where no rootless Podman runs, no test starts a
 * container, and there is nothing to remove.
 */
export async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  const run = runOf(process.pid);
  project.provide('trierarchTestRun', run);
  const podman = await rootlessPodman({ platform: process.platform, info: () => runCommand('podman', { args: ['info', '--format', '{{.Host.Security.Rootless}}'] }) });
  if (!podman.isUsable) {
    return undefined;
  }
  await removeEarlierRuns();
  return () => removeRun(run);
}
