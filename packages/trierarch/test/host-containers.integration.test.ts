import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { FAKE_CLAUDE_CODE, TRIERARCH_PROGRAM } from './support/hold-program.js';
import { newId } from './support/in-memory.js';
import { buildTestSessionImage, rootlessPodman } from './support/podman.js';
import { aShortHome } from './support/short-home.js';
import { createHoldRuntime } from '../src/adapters/hold-runtime.js';
import { shipPodmanRuntime, userRuntimeDirectory } from '../src/adapters/paths.js';
import { runCommand } from '../src/adapters/run-command.js';
import { removeWithinIsolatedUserNamespace } from '../src/adapters/trash.js';
import { runningVersion } from '../src/adapters/version.js';

const podman = await rootlessPodman({ platform: process.platform, info: () => runCommand('podman', { args: ['info', '--format', '{{.Host.Security.Rootless}}'] }) });

it("cleans up a killed host session's Testcontainers container and volume on restart", async (context) => {
  if (!podman.isUsable) context.skip(podman.reason);
  const sessions = realpathSync(aShortHome('aeolus-holds'));
  const folder = realpathSync(aShortHome('aeolus-folder'));
  const executable = await runCommand('sh', { args: ['-c', 'command -v podman'] });
  expect(executable.status, executable.stderr).toBe(0);
  const commands = join(folder, 'podman-commands');
  const holdLog = join(folder, 'hold.log');
  const wrapper = join(folder, 'podman');
  writeFileSync(wrapper, `#!/bin/sh
"${executable.stdout.trim()}" "$@" 2> "$0.$$.stderr"
status=$?
{ printf 'command: %s\\nstatus: %s\\n' "$*" "$status"; cat "$0.$$.stderr"; } >> '${commands}'
cat "$0.$$.stderr" >&2
rm -f "$0.$$.stderr"
exit "$status"
`);
  chmodSync(wrapper, 0o755);
  const launcher = join(folder, 'hold-launcher');
  writeFileSync(launcher, `#!/bin/sh\nexec "$@" >> '${holdLog}' 2>&1\n`);
  chmodSync(launcher, 0o755);
  const runtime = createHoldRuntime({ sessions, program: ['env', `PATH=${folder}:${process.env.PATH ?? '/usr/bin:/bin'}`, launcher, ...TRIERARCH_PROGRAM], version: runningVersion(), platform: process.platform, hasHostContainerStorage: true });
  const shipId = newId('ship');
  const shipFolder = join(sessions, shipId + '-ship');
  const name = `test-${shipId}`;
  const ready = join(folder, 'testcontainers-ready');
  const program = `const { createRequire } = require('node:module');
    const { GenericContainer } = createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))})('testcontainers');
    (async () => {
      await new GenericContainer('docker.io/library/postgres:17-alpine').withName(${JSON.stringify(name)}).withEnvironment({ POSTGRES_PASSWORD: 'test' }).start();
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
      setInterval(() => {}, 1000);
    })().catch(e => { console.log(JSON.stringify({ type: 'error', message: String(e) })); process.exit(1); });`;
  const session = { shipId, shipFolder, folder, command: [process.execPath, '-e', program], harness: 'claude-code', env: { TESTCONTAINERS_RYUK_DISABLED: 'true', TESTCONTAINERS_HOST_OVERRIDE: '127.0.0.1' } };
  const url = `unix://${shipFolder}/podman.sock`;
  const client = (args: string[]) => runCommand('env', { args: ['-u', 'CONTAINER_HOST', '-u', 'DOCKER_HOST', 'podman', '--url', url, ...args] });
  const own = (args: string[]) => runCommand('env', { args: ['-u', 'CONTAINER_HOST', '-u', 'DOCKER_HOST', 'podman', ...args] });
  const ownImage = `localhost/tri348-${shipId}:latest`;
  const ownContainer = `tri348-${shipId}`;
  const runtimeRoot = await userRuntimeDirectory();
  if (runtimeRoot === undefined) throw new Error('no private user runtime directory');
  const runtimeDirectory = shipPodmanRuntime(runtimeRoot, shipId);
  try {
    await buildTestSessionImage(ownImage);
    const started = await own(['run', '--detach', '--name', ownContainer, '--network', 'bridge', ownImage, 'sleep', '120']);
    expect(started.status).toBe(0);
    await runtime.start(session);
    const info = await client(['info', '--format', '{{.Store.GraphRoot}}']);
    expect(info.status, info.stderr).toBe(0);
    expect(info.stdout.trim()).toBe(join(shipFolder, 'containers', 'graph'));
    await expect.poll(() => existsSync(ready), { timeout: 180_000 }).toBe(true);
    const before = await client(['ps', '--all', '--filter', `name=${name}`, '--format', '{{.Names}}']);
    const volumes = await client(['volume', 'ls', '--quiet']);
    const images = await client(['image', 'ls', '--quiet']);
    expect(images.stdout.trim()).not.toBe('');
    expect(before.stdout.trim()).toBe(name);
    expect(volumes.stdout.trim()).not.toBe('');
    const ownVolumes = await runCommand('env', { args: ['-u', 'CONTAINER_HOST', '-u', 'DOCKER_HOST', 'podman', 'volume', 'ls', '--quiet'] });
    expect(ownVolumes.stdout.split('\n')).not.toContain(volumes.stdout.trim());
    const holdPid = Number(readFileSync(join(sessions, shipId, 'hold.pid'), 'utf8'));
    expect(holdPid).toBeGreaterThan(1);
    process.kill(holdPid, 'SIGKILL');
    await expect.poll(() => existsSync(join(sessions, shipId, 'guard-done'))).toBe(true);
    mkdirSync(join(runtimeDirectory, 'run'), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeDirectory, 'tmp'), { recursive: true, mode: 0o700 });
    const storageClient = (args: string[]) => runCommand('env', { args: ['-u', 'CONTAINER_HOST', '-u', 'DOCKER_HOST', `CONTAINERS_STORAGE_CONF=${join(shipFolder, 'containers', 'storage.conf')}`, 'podman', '--root', join(shipFolder, 'containers', 'graph'), '--runroot', join(runtimeDirectory, 'run'), '--tmpdir', join(runtimeDirectory, 'tmp'), ...args] });
    const crashed = await storageClient(['ps', '--all', '--format', '{{.Names}}']);
    expect(crashed.status, crashed.stderr).toBe(0);
    expect(crashed.stdout.trim()).toBe(name);
    const abandonedVolumes = await storageClient(['volume', 'ls', '--quiet']);
    expect(abandonedVolumes.status, abandonedVolumes.stderr).toBe(0);
    expect(abandonedVolumes.stdout.trim()).toBe(volumes.stdout.trim());
    await runtime.start({ ...session, command: [...FAKE_CLAUDE_CODE] });
    const after = await client(['ps', '--all', '--quiet']);
    const remaining = await client(['volume', 'ls', '--quiet']);
    const retained = await client(['image', 'ls', '--quiet']);
    expect([after.status, remaining.status, retained.status]).toEqual([0, 0, 0]);
    const diagnostics = () => [readFileSync(holdLog, 'utf8'), readFileSync(join(sessions, shipId, 'events.jsonl'), 'utf8'), readFileSync(commands, 'utf8')].join('\n');
    expect(retained.stdout.trim(), retained.stdout.trim() === images.stdout.trim() ? undefined : diagnostics()).toBe(images.stdout.trim());
    expect([after.stdout.trim(), remaining.stdout.trim()]).toEqual(['', '']);
    const ownContainers = await own(['ps', '--all', '--filter', `name=${name}`, '--quiet']);
    expect(ownContainers.stdout.trim()).toBe('');
    const bridge = await own(['run', '--rm', '--network', 'bridge', ownImage, '/bin/sh', '-c', ':']);
    expect(bridge.status, bridge.stderr).toBe(0);
  } finally {
    await runtime.stop(shipId);
    await own(['rm', '--force', '--time', '0', ownContainer]);
    await own(['image', 'rm', '--force', ownImage]);
    const config = join(shipFolder, 'containers', 'storage.conf');
    if (existsSync(config)) {
      await runCommand('env', { args: ['-u', 'CONTAINER_HOST', '-u', 'DOCKER_HOST', `CONTAINERS_STORAGE_CONF=${config}`, 'podman', '--root', join(shipFolder, 'containers', 'graph'), '--runroot', join(runtimeDirectory, 'run'), '--tmpdir', join(runtimeDirectory, 'tmp'), 'rm', '--all', '--force', '--time', '0', '--volumes'] });
      await removeWithinIsolatedUserNamespace('podman')(shipFolder);
    }
    rmSync(runtimeDirectory, { recursive: true, force: true });
    await removeWithinIsolatedUserNamespace('podman')(sessions);
    rmSync(folder, { recursive: true, force: true });
  }
}, 240_000);
