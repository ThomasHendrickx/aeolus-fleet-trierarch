import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';

import { runCommand } from '../../src/adapters/run-command.js';
import { newId } from './in-memory.js';
import { buildTestSessionImage, rootlessPodman } from './podman.js';
import { TEST_RUN_LABEL } from './test-run.js';

// A suite that starts the test session image's container and leaves it, run
// under this package's own global setup as a program, as an interrupted run
// would leave it (#345): killed, its afterAll never reached.

const podman = await rootlessPodman({ platform: process.platform, info: () => runCommand('podman', { args: ['info', '--format', '{{.Host.Security.Rootless}}'] }) });

const VITEST = fileURLToPath(new URL('../../../../node_modules/vitest/vitest.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/test-run/', import.meta.url));
const RUN_TIMEOUT_MS = 120_000;

/** What a fixture run left on the machine: its containers and its test image, by name. */
const leftOf = async (marker: string) => ({
  containers: (await runCommand('podman', { args: ['ps', '--all', '--filter', `name=trierarch-test-${marker}`, '--format', '{{.Names}}'] })).stdout.trim(),
  images: (await runCommand('podman', { args: ['images', '--filter', `reference=localhost/aeolus-trierarch-test:${marker}`, '--format', '{{.Repository}}:{{.Tag}}'] })).stdout.trim(),
});

/** Runs the fixture suite under its marker; one that hangs runs until it is killed. */
function startFixtureRun(marker: string, options: { hangs: boolean }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
  const run = spawn(process.execPath, [VITEST, 'run', '--root', FIXTURE], {
    env: { ...env, AEOLUS_TEST_RUN_MARKER: marker, AEOLUS_TEST_RUN_HANGS: options.hangs ? '1' : '0' },
    // Its own process group, so a kill reaches its workers too, as an interrupt of the whole run does.
    detached: true,
    stdio: 'ignore',
  });
  const exited = new Promise<number | null>((resolve) => run.on('exit', (code) => resolve(code)));
  return { pid: run.pid ?? 0, exited };
}

describe('the test runs of this package on this machine', () => {
  let markers: string[];
  let unrelated: string[];

  // First, so a skip runs neither the setup nor the cleanup, which need podman.
  beforeEach((context) => {
    if (!podman.isUsable) {
      context.skip(podman.reason);
    }
  });

  beforeEach(() => {
    markers = [newId('ship').slice(-8), newId('ship').slice(-8), newId('ship').slice(-8)];
    unrelated = [];
  });

  afterEach(async () => {
    for (const marker of markers) {
      await runCommand('podman', { args: ['rm', '--force', '--time', '0', `trierarch-test-${marker}`] });
      await runCommand('podman', { args: ['image', 'rm', '--force', `localhost/aeolus-trierarch-test:${marker}`] });
    }
    if (unrelated.length > 0) {
      await runCommand('podman', { args: ['rm', '--force', '--time', '0', ...unrelated] });
    }
  });

  it(
    'leaves no container or test image of its own behind when it ends',
    async () => {
      const [marker = ''] = markers;

      await expect(startFixtureRun(marker, { hangs: false }).exited).resolves.toBe(0);

      expect(await leftOf(marker)).toEqual({ containers: '', images: '' });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'removes what an interrupted run left before the next run starts, and nothing of a run still going or of no run',
    async () => {
      const [interrupted = '', next = '', other = ''] = markers;
      const interruptedRun = startFixtureRun(interrupted, { hangs: true });
      await expect.poll(async () => (await leftOf(interrupted)).containers, { timeout: RUN_TIMEOUT_MS / 2 }).not.toBe('');
      process.kill(-interruptedRun.pid, 'SIGKILL');
      await interruptedRun.exited;
      const leftByTheKill = await leftOf(interrupted);
      // An image of no run, with a container of no run and one of this run, a run still going.
      const otherImage = await buildTestSessionImage(`localhost/aeolus-trierarch-test:${other}`);
      const ofThisRun = `trierarch-test-${newId('ship').slice(-8)}`;
      const ofNoRun = `trierarch-test-${newId('ship').slice(-8)}`;
      unrelated.push(ofThisRun, ofNoRun);
      await runCommand('podman', { args: ['run', '--detach', '--name', ofThisRun, '--label', `${TEST_RUN_LABEL}=${inject('testRun')}`, otherImage, 'sleep', '300'] });
      await runCommand('podman', { args: ['run', '--detach', '--name', ofNoRun, otherImage, 'sleep', '300'] });

      await expect(startFixtureRun(next, { hangs: false }).exited).resolves.toBe(0);

      const kept = (await runCommand('podman', { args: ['ps', '--all', '--filter', `name=${ofThisRun}`, '--filter', `name=${ofNoRun}`, '--format', '{{.Names}}'] })).stdout.trim().split('\n').toSorted();
      expect({ leftByTheKill: leftByTheKill.containers !== '', afterTheNextRun: await leftOf(interrupted), kept, keptImage: (await leftOf(other)).images }).toEqual({
        leftByTheKill: true,
        afterTheNextRun: { containers: '', images: '' },
        kept: [ofThisRun, ofNoRun].toSorted(),
        keptImage: otherImage,
      });
    },
    RUN_TIMEOUT_MS,
  );
});
