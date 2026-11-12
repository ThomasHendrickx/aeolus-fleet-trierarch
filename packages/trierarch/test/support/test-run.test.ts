import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';

import { type CommandResult, runCommand } from '../../src/adapters/run-command.js';
import { newId } from './in-memory.js';
import { buildTestSessionImage, rootlessPodman } from './podman.js';
import { TEST_RUN_LABEL, removeEarlierRuns, removeRun } from './test-run.js';

// A suite that starts the test session image's container, with a volume, and
// leaves it, run under this package's own global setup as a program: as a run
// whose test fails would leave it, or an interrupted run, killed, its afterAll
// never reached (#345).

const podman = await rootlessPodman({ platform: process.platform, info: () => runCommand('podman', { args: ['info', '--format', '{{.Host.Security.Rootless}}'] }) });

const VITEST = fileURLToPath(new URL('../../../../node_modules/vitest/vitest.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/test-run/', import.meta.url));
const RUN_TIMEOUT_MS = 240_000;

/** What a Podman call printed, trimmed; a call that fails throws, so a failed listing never reads as nothing left. */
async function podmanPrinted(args: readonly string[]): Promise<string> {
  const answer = await runCommand('podman', { args });
  if (answer.status !== 0) {
    throw new Error(`podman ${args.join(' ')} failed: ${answer.stderr.trim()}`);
  }
  return answer.stdout.trim();
}

/** What a fixture run left on the machine: its containers, its volume and its test image, by name. */
const leftOf = async (marker: string, volume: string) => ({
  containers: await podmanPrinted(['ps', '--all', '--filter', `name=trierarch-test-${marker}`, '--format', '{{.Names}}']),
  volumes: await podmanPrinted(['volume', 'ls', '--filter', `name=${volume}`, '--format', '{{.Name}}']),
  images: await podmanPrinted(['images', '--filter', `reference=localhost/aeolus-trierarch-test:${marker}`, '--format', '{{.Repository}}:{{.Tag}}']),
});

/** How a fixture run's test ends: it passes, it fails, or it hangs until the run is killed. */
type Ending = 'passes' | 'fails' | 'hangs';

/** Runs the fixture suite under its marker. Its output comes with its exit, so a failed run says why, with the volume its container mounted, as the run wrote it. */
function startFixtureRun(marker: string, ending: Ending) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
  const volumeFile = join(mkdtempSync(join(tmpdir(), 'trierarch-test-run-')), 'volume');
  const run = spawn(process.execPath, [VITEST, 'run', '--root', FIXTURE], {
    env: { ...env, NO_COLOR: '1', AEOLUS_TEST_RUN_MARKER: marker, AEOLUS_TEST_RUN_ENDS: ending, AEOLUS_TEST_RUN_VOLUME_FILE: volumeFile },
    // Its own process group, so a kill reaches its workers too, as an interrupt of the whole run does.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  run.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  run.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<{ code: number | null; volume: string; output: string }>((resolve) => {
    run.on('close', (code) => {
      const volume = existsSync(volumeFile) ? readFileSync(volumeFile, 'utf8') : '';
      rmSync(dirname(volumeFile), { recursive: true, force: true });
      resolve({ code, volume, output });
    });
  });
  return { pid: run.pid ?? 0, exited };
}

describe('the test runs of this package on this machine', () => {
  let markers: string[];
  let unrelated: string[];
  let volumes: string[];

  // First, so a skip runs neither the setup nor the cleanup, which need podman.
  beforeEach((context) => {
    if (!podman.isUsable) {
      context.skip(podman.reason);
    }
  });

  beforeEach(() => {
    markers = [newId('ship').slice(-8), newId('ship').slice(-8), newId('ship').slice(-8)];
    unrelated = [];
    volumes = [];
  });

  afterEach(async () => {
    await runCommand('podman', { args: ['rm', '--force', '--volumes', '--time', '0', ...unrelated, ...markers.map((marker) => `trierarch-test-${marker}`)] });
    if (volumes.length > 0) {
      await runCommand('podman', { args: ['volume', 'rm', '--force', ...volumes] });
    }
    await runCommand('podman', { args: ['image', 'rm', '--force', ...markers.map((marker) => `localhost/aeolus-trierarch-test:${marker}`)] });
  }, RUN_TIMEOUT_MS);

  it(
    'leaves no container, volume or test image of its own behind when it ends',
    async () => {
      const [marker = ''] = markers;

      const ended = await startFixtureRun(marker, 'passes').exited;
      volumes.push(ended.volume);

      expect({ code: ended.code, hasVolume: ended.volume !== '', left: await leftOf(marker, ended.volume) }).toEqual({ code: 0, hasVolume: true, left: { containers: '', volumes: '', images: '' } });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'leaves no container, volume or test image of its own behind when a test fails',
    async () => {
      const [marker = ''] = markers;

      const ended = await startFixtureRun(marker, 'fails').exited;
      volumes.push(ended.volume);

      expect({ code: ended.code, hasVolume: ended.volume !== '', left: await leftOf(marker, ended.volume) }).toEqual({ code: 1, hasVolume: true, left: { containers: '', volumes: '', images: '' } });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'removes what an interrupted run left before the next run starts, and nothing of a run still going or of no run',
    async () => {
      const [interrupted = '', next = '', other = ''] = markers;
      const interruptedRun = startFixtureRun(interrupted, 'hangs');
      await expect.poll(async () => (await leftOf(interrupted, '')).containers, { timeout: RUN_TIMEOUT_MS / 2 }).not.toBe('');
      const volume = await podmanPrinted(['inspect', `trierarch-test-${interrupted}`, '--format', '{{range .Mounts}}{{.Name}}{{end}}']);
      volumes.push(volume);
      process.kill(-interruptedRun.pid, 'SIGKILL');
      await interruptedRun.exited;
      const leftByTheKill = await leftOf(interrupted, volume);
      // An image of no run, with a container of no run and one of this run, a run still going.
      const otherImage = await buildTestSessionImage(`localhost/aeolus-trierarch-test:${other}`);
      const ofThisRun = `trierarch-test-${newId('ship').slice(-8)}`;
      const ofNoRun = `trierarch-test-${newId('ship').slice(-8)}`;
      unrelated.push(ofThisRun, ofNoRun);
      await podmanPrinted(['run', '--detach', '--name', ofThisRun, '--label', `${TEST_RUN_LABEL}=${inject('trierarchTestRun')}`, otherImage, 'sleep', '300']);
      await podmanPrinted(['run', '--detach', '--name', ofNoRun, otherImage, 'sleep', '300']);

      const nextRun = await startFixtureRun(next, 'passes').exited;
      volumes.push(nextRun.volume);
      expect(nextRun).toMatchObject({ code: 0 });

      const kept = (await podmanPrinted(['ps', '--all', '--filter', `name=${ofThisRun}`, '--filter', `name=${ofNoRun}`, '--format', '{{.Names}}'])).split('\n').toSorted();
      expect({ leftByTheKill: { container: leftByTheKill.containers !== '', volume: volume !== '' && leftByTheKill.volumes === volume }, afterTheNextRun: await leftOf(interrupted, volume), kept, keptImage: (await leftOf(other, '')).images }).toEqual({
        leftByTheKill: { container: true, volume: true },
        afterTheNextRun: { containers: '', volumes: '', images: '' },
        kept: [ofThisRun, ofNoRun].toSorted(),
        keptImage: otherImage,
      });
    },
    RUN_TIMEOUT_MS,
  );
});

/** The Podman calls of the cleanup, by their first arguments. */
type PodmanCall = 'ps' | 'images' | 'rm' | 'image rm';

/** A stand-in Podman that lists a container and a test image of an ended run, and fails the one call it is told to, as Podman does: a nonzero exit, saying why. */
function podmanFailingAt(failing: PodmanCall) {
  return (_command: 'podman', options: { args: readonly string[] }): Promise<CommandResult> => {
    const [first = '', second = ''] = options.args;
    const call = first === 'image' ? `${first} ${second}` : first;
    if (call === failing) {
      return Promise.resolve({ status: 125, stdout: '', stderr: `Error: ${call} cannot reach the Podman service\n` });
    }
    const listed = call === 'ps' ? 'c0ffee of-an-ended-run\n' : call === 'images' ? 'beef00 of-an-ended-run\n' : '';
    return Promise.resolve({ status: 0, stdout: listed, stderr: '' });
  };
}

describe('the cleanup of the test runs when Podman fails', () => {
  it('fails, saying why, when Podman cannot list the containers of the test runs', async () => {
    await expect(removeEarlierRuns(podmanFailingAt('ps'))).rejects.toThrow('listing the containers of the test runs failed: Error: ps cannot reach the Podman service');
  });

  it('fails, saying why, when Podman cannot list the test images of the test runs', async () => {
    await expect(removeEarlierRuns(podmanFailingAt('images'))).rejects.toThrow('listing the test images of the test runs failed: Error: images cannot reach the Podman service');
  });

  it('fails, saying why, when Podman cannot remove the containers of the test runs', async () => {
    await expect(removeEarlierRuns(podmanFailingAt('rm'))).rejects.toThrow('removing the containers of the test runs failed: Error: rm cannot reach the Podman service');
  });

  it('fails, saying why, when Podman cannot remove the test images of the test runs', async () => {
    await expect(removeEarlierRuns(podmanFailingAt('image rm'))).rejects.toThrow('removing the test images of the test runs failed: Error: image rm cannot reach the Podman service');
  });

  it('fails after a run, saying why, when Podman cannot remove what the run left', async () => {
    await expect(removeRun('of-an-ended-run', podmanFailingAt('rm'))).rejects.toThrow('removing the containers of the test runs failed: Error: rm cannot reach the Podman service');
  });
});
